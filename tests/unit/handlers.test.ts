import { describe, expect, it } from 'vitest';
import { HttpsError } from 'firebase-functions/v2/https';

import { handleRequestOtp, handleVerifyOtp } from '../../functions/src/api/handlers';
import { MockDeliveryProvider } from '../../functions/src/delivery/mock-provider';
import { COLLECTIONS } from '../../functions/src/storage/types';
import { extractOtpCodeFromMessage, createEngineFixture } from '../helpers/engine-fixture';

const CONTEXT = { requesterHash: 'requester-1' };
const REQUEST_PAYLOAD = { phone: '+919876543210', purpose: 'sign-in' };

async function captureHttpsError(promise: Promise<unknown>): Promise<HttpsError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpsError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the promise to reject with an HttpsError');
}

describe('handleRequestOtp', () => {
  it('returns the enumeration-resistant creation response', async () => {
    const fixture = createEngineFixture();

    const response = await handleRequestOtp(fixture.engine, REQUEST_PAYLOAD, CONTEXT);

    expect(Object.keys(response).sort()).toEqual([
      'challengeId',
      'expiresInSeconds',
      'resendAfterSeconds',
    ]);
    expect(response.expiresInSeconds).toBe(300);
    expect(response.resendAfterSeconds).toBe(60);
    expect(JSON.stringify(response)).not.toContain('9876543210');
  });

  it('maps malformed payloads to INVALID_REQUEST', async () => {
    const fixture = createEngineFixture();

    for (const payload of [null, 'string', { phone: 'not-a-phone', purpose: 'sign-in' }]) {
      const error = await captureHttpsError(handleRequestOtp(fixture.engine, payload, CONTEXT));
      expect(error.code).toBe('invalid-argument');
      expect(error.details).toEqual({ code: 'INVALID_REQUEST' });
    }
  });

  it('maps cooldown to RESEND_COOLDOWN with retry-after', async () => {
    const fixture = createEngineFixture();
    await handleRequestOtp(fixture.engine, REQUEST_PAYLOAD, CONTEXT);

    const error = await captureHttpsError(
      handleRequestOtp(fixture.engine, REQUEST_PAYLOAD, CONTEXT),
    );

    expect(error.code).toBe('resource-exhausted');
    expect(error.details).toEqual({ code: 'RESEND_COOLDOWN', retryAfterSeconds: 60 });
  });

  it('maps rate limits to RATE_LIMITED', async () => {
    const fixture = createEngineFixture({
      policy: { globalRequestsPerMinute: 1 },
    });
    await handleRequestOtp(fixture.engine, REQUEST_PAYLOAD, CONTEXT);

    const error = await captureHttpsError(
      handleRequestOtp(
        fixture.engine,
        { phone: '+919999999999', purpose: 'sign-in' },
        { requesterHash: 'requester-2' },
      ),
    );

    expect(error.code).toBe('resource-exhausted');
    expect(error.details).toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('maps delivery failures to SERVICE_UNAVAILABLE', async () => {
    const fixture = createEngineFixture({
      providerOptions: {
        failWith: { code: 'PROVIDER_UNAVAILABLE', message: 'down', retryable: true },
      },
    });

    const error = await captureHttpsError(
      handleRequestOtp(fixture.engine, REQUEST_PAYLOAD, CONTEXT),
    );

    expect(error.code).toBe('unavailable');
    expect(error.details).toEqual({ code: 'SERVICE_UNAVAILABLE', retryAfterSeconds: 5 });
  });
});

describe('handleVerifyOtp', () => {
  async function createdChallenge(fixture: ReturnType<typeof createEngineFixture>) {
    const response = await handleRequestOtp(fixture.engine, REQUEST_PAYLOAD, CONTEXT);
    const provider = fixture.provider;
    if (!(provider instanceof MockDeliveryProvider)) {
      throw new Error('expected mock provider');
    }
    const message = provider.recordedMessages.at(-1);
    if (message === undefined) {
      throw new Error('no message recorded');
    }
    return { challengeId: response.challengeId, code: extractOtpCodeFromMessage(message.body) };
  }

  it('returns a verified response for the correct code', async () => {
    const fixture = createEngineFixture();
    const { challengeId, code } = await createdChallenge(fixture);

    const response = await handleVerifyOtp(
      fixture.engine,
      { challengeId, code, purpose: 'sign-in' },
      CONTEXT,
    );

    expect(response).toEqual({ verified: true, purpose: 'sign-in' });
  });

  it('maps every failed verification to the same generic CODE_INVALID error', async () => {
    const fixture = createEngineFixture();
    const { challengeId, code } = await createdChallenge(fixture);
    const wrong = String((Number(code[0] ?? '0') + 1) % 10) + code.slice(1);

    const errors = await Promise.all([
      captureHttpsError(
        handleVerifyOtp(fixture.engine, { challengeId, code: wrong, purpose: 'sign-in' }, CONTEXT),
      ),
      captureHttpsError(
        handleVerifyOtp(
          fixture.engine,
          { challengeId: 'c_AAAAAAAAAAAAAAAAAAAAAA', code, purpose: 'sign-in' },
          CONTEXT,
        ),
      ),
    ]);

    for (const error of errors) {
      expect(error.code).toBe('permission-denied');
      expect(error.details).toMatchObject({ code: 'CODE_INVALID' });
      expect(error.message).not.toMatch(/wrong|expired|locked|consumed|void/i);
    }

    const malformed = await captureHttpsError(
      handleVerifyOtp(fixture.engine, { challengeId, code, purpose: 'bogus' }, CONTEXT),
    );
    expect(malformed.code).toBe('invalid-argument');
    expect(malformed.details).toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('maps verify rate limits to RATE_LIMITED', async () => {
    const fixture = createEngineFixture({
      policy: { requesterVerifyLimit: { max: 1, windowSeconds: 600 } },
    });
    const { challengeId, code } = await createdChallenge(fixture);
    const wrong = String((Number(code[0] ?? '0') + 1) % 10) + code.slice(1);
    const first = await captureHttpsError(
      handleVerifyOtp(fixture.engine, { challengeId, code: wrong, purpose: 'sign-in' }, CONTEXT),
    );
    expect(first.details).toMatchObject({ code: 'CODE_INVALID' });

    const error = await captureHttpsError(
      handleVerifyOtp(fixture.engine, { challengeId, code, purpose: 'sign-in' }, CONTEXT),
    );

    expect(error.code).toBe('resource-exhausted');
    expect(error.details).toMatchObject({ code: 'RATE_LIMITED' });
  });
});

describe('input bounds', () => {
  it('rejects oversized externally supplied strings before expensive processing', async () => {
    const fixture = createEngineFixture();
    const oversizedDigits = '9'.repeat(100_000);

    const requestError = await captureHttpsError(
      handleRequestOtp(fixture.engine, { phone: oversizedDigits, purpose: 'sign-in' }, CONTEXT),
    );
    expect(requestError.code).toBe('invalid-argument');
    expect(requestError.details).toEqual({ code: 'INVALID_REQUEST' });

    const verifyErrors = await Promise.all([
      captureHttpsError(
        handleVerifyOtp(
          fixture.engine,
          { challengeId: `c_${'A'.repeat(100_000)}`, code: '123456', purpose: 'sign-in' },
          CONTEXT,
        ),
      ),
      captureHttpsError(
        handleVerifyOtp(
          fixture.engine,
          { challengeId: 'c_AAAAAAAAAAAAAAAAAAAAAA', code: oversizedDigits, purpose: 'sign-in' },
          CONTEXT,
        ),
      ),
    ]);
    for (const error of verifyErrors) {
      expect(error.code).toBe('invalid-argument');
      expect(error.details).toEqual({ code: 'INVALID_REQUEST' });
    }

    expect(fixture.db.countCollection(COLLECTIONS.challenges)).toBe(0);
    expect(fixture.db.countCollection(COLLECTIONS.deliveryJobs)).toBe(0);
  });
});
