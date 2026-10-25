import { describe, expect, it } from 'vitest';
import { HttpsError } from 'firebase-functions/v2/https';

import { handleRequestOtp, handleVerifyOtp } from '../../functions/src/api/handlers';
import type { CustomTokenIssuer } from '../../functions/src/auth/token-issuer';
import { MockDeliveryProvider } from '../../functions/src/delivery/mock-provider';
import { IdentityCreationService } from '../../functions/src/identity/creation';
import {
  AuthPhoneAlreadyExistsError,
  AuthUnavailableError,
} from '../../functions/src/identity/errors';
import { IdentityResolver } from '../../functions/src/identity/resolver';
import { hashPhone } from '../../functions/src/otp/hashing';
import type { ChallengeRecord } from '../../functions/src/otp/types';
import { COLLECTIONS, docRef } from '../../functions/src/storage/types';
import { createEngineFixture, extractOtpCodeFromMessage } from '../helpers/engine-fixture';
import { FakeAuthPort, InMemoryIdentityStore } from '../helpers/identity-fakes';

const CONTEXT = { requesterHash: 'requester-1' };
const REQUEST_PAYLOAD = { phone: '+919876543210', purpose: 'sign-in' };
const PHONE = REQUEST_PAYLOAD.phone;

class FakeTokenIssuer implements CustomTokenIssuer {
  readonly calls: string[] = [];
  fail = false;

  tokenFor(uid: string): string {
    return `fake-custom-token-${uid}`;
  }

  async createCustomToken(uid: string): Promise<string> {
    this.calls.push(uid);
    if (this.fail) {
      throw new AuthUnavailableError('token mint failed', 'auth/internal-error');
    }
    return this.tokenFor(uid);
  }
}

function createVerifyFixture(options?: Parameters<typeof createEngineFixture>[0]) {
  const base = createEngineFixture(options);
  const store = new InMemoryIdentityStore();
  const auth = new FakeAuthPort();
  const tokens = new FakeTokenIssuer();
  const resolver = new IdentityResolver({
    store,
    auth,
    clock: () => base.clock.now(),
    logger: base.logger,
    audit: base.audit,
    pepper: base.pepper,
    pepperVersion: base.pepperVersion,
  });
  const identity = new IdentityCreationService({
    resolver,
    store,
    auth,
    clock: () => base.clock.now(),
    logger: base.logger,
    audit: base.audit,
    pepper: base.pepper,
    pepperVersion: base.pepperVersion,
    sleep: async () => undefined,
  });
  const verifyDeps = {
    engine: base.engine,
    identity,
    tokens,
    audit: base.audit,
    logger: base.logger,
    clock: () => base.clock.now(),
  };
  return { ...base, store, auth, tokens, identity, verifyDeps };
}

type VerifyFixture = ReturnType<typeof createVerifyFixture>;

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

async function challengeRecord(
  fixture: VerifyFixture,
  challengeId: string,
): Promise<ChallengeRecord | undefined> {
  return (await fixture.db.get<ChallengeRecord>(docRef(COLLECTIONS.challenges, challengeId)))?.data;
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

  it('rejects non-sign-in purposes at the API boundary', async () => {
    const fixture = createEngineFixture();

    const error = await captureHttpsError(
      handleRequestOtp(
        fixture.engine,
        { phone: REQUEST_PAYLOAD.phone, purpose: 'phone-verification' },
        CONTEXT,
      ),
    );

    expect(error.code).toBe('invalid-argument');
    expect(error.details).toEqual({ code: 'INVALID_REQUEST' });
    expect(fixture.db.countCollection(COLLECTIONS.challenges)).toBe(0);
  });

  it('maps malformed payloads to INVALID_REQUEST', async () => {
    const fixture = createEngineFixture();

    for (const payload of [
      null,
      'string',
      { phone: 'not-a-phone', purpose: 'sign-in' },
      { phone: REQUEST_PAYLOAD.phone },
    ]) {
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
  async function createdChallenge(fixture: VerifyFixture) {
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

  it('mints a token for the created UID and returns only the approved response fields', async () => {
    const fixture = createVerifyFixture();
    const { challengeId, code } = await createdChallenge(fixture);

    const response = await handleVerifyOtp(
      fixture.verifyDeps,
      {
        challengeId,
        code,
        purpose: 'sign-in',
        phone: PHONE,
        uid: 'uid_attacker',
        role: 'admin',
      },
      CONTEXT,
    );

    expect(Object.keys(response).sort()).toEqual(['customToken', 'purpose', 'verified']);
    const uid = fixture.tokens.calls[0];
    if (uid === undefined) {
      throw new Error('expected token issuance');
    }
    expect(response).toEqual({
      verified: true,
      purpose: 'sign-in',
      customToken: fixture.tokens.tokenFor(uid),
    });
    await expect(fixture.auth.getUserByPhoneNumber(PHONE)).resolves.toMatchObject({ uid });
    expect(fixture.store.peekLink(hashPhone(fixture.pepper, PHONE))).toMatchObject({
      status: 'active',
      uid,
    });
    expect((await challengeRecord(fixture, challengeId))?.status).toBe('consumed');
    expect(fixture.audit.events.find((event) => event.type === 'token.issued')).toMatchObject({
      uid,
      outcome: 'success',
      reasonCode: null,
    });

    const serialized = fixture.logger.toJSON() + fixture.audit.toJSON();
    expect(serialized).not.toContain('9876543210');
    expect(serialized).not.toContain('+91');
    expect(serialized).not.toContain('uid_attacker');
    expect(serialized).not.toContain(response.customToken);
  });

  it('mints a token for an existing authoritative user without creating another', async () => {
    const fixture = createVerifyFixture();
    fixture.auth.seedUser({ uid: 'uid_existing', phoneNumber: PHONE, disabled: false });
    const { challengeId, code } = await createdChallenge(fixture);

    const response = await handleVerifyOtp(
      fixture.verifyDeps,
      { challengeId, code, purpose: 'sign-in', phone: PHONE },
      CONTEXT,
    );

    expect(response.customToken).toBe(fixture.tokens.tokenFor('uid_existing'));
    expect(fixture.auth.createCalls).toHaveLength(0);
    expect(fixture.tokens.calls).toEqual(['uid_existing']);
    expect(fixture.store.peekLink(hashPhone(fixture.pepper, PHONE))).toMatchObject({
      status: 'active',
      uid: 'uid_existing',
    });
  });

  it('recovers a duplicate Auth phone and mints a token for the authoritative UID', async () => {
    const fixture = createVerifyFixture();
    fixture.auth.lookupByPhoneQueue = [
      null,
      null,
      { uid: 'uid_winner', phoneNumber: PHONE, disabled: false },
    ];
    fixture.auth.nextCreateError = new AuthPhoneAlreadyExistsError(
      'phone already registered',
      'auth/phone-number-already-exists',
    );
    const { challengeId, code } = await createdChallenge(fixture);

    const response = await handleVerifyOtp(
      fixture.verifyDeps,
      { challengeId, code, purpose: 'sign-in', phone: PHONE },
      CONTEXT,
    );

    expect(response.customToken).toBe(fixture.tokens.tokenFor('uid_winner'));
    expect(fixture.auth.createCalls).toHaveLength(1);
    expect(fixture.tokens.calls).toEqual(['uid_winner']);
    expect(fixture.store.peekLink(hashPhone(fixture.pepper, PHONE))).toMatchObject({
      status: 'active',
      uid: 'uid_winner',
    });
    expect(fixture.audit.events.some((event) => event.type === 'identity.resolved')).toBe(true);
  });

  it('does not consume or mint on a phone-binding mismatch', async () => {
    const fixture = createVerifyFixture();
    const { challengeId, code } = await createdChallenge(fixture);

    const error = await captureHttpsError(
      handleVerifyOtp(
        fixture.verifyDeps,
        { challengeId, code, purpose: 'sign-in', phone: '+919876543211' },
        CONTEXT,
      ),
    );

    expect(error.code).toBe('permission-denied');
    expect(error.details).toEqual({ code: 'CODE_INVALID' });
    expect(await challengeRecord(fixture, challengeId)).toMatchObject({
      status: 'pending',
      attempts: 0,
    });
    expect(fixture.tokens.calls).toHaveLength(0);
    expect(fixture.auth.createCalls).toHaveLength(0);
    expect(fixture.store.peekLink(hashPhone(fixture.pepper, PHONE))).toBeUndefined();

    const verified = await handleVerifyOtp(
      fixture.verifyDeps,
      { challengeId, code, purpose: 'sign-in', phone: PHONE },
      CONTEXT,
    );
    expect(verified.verified).toBe(true);
  });

  it('maps every failed verification to the same generic CODE_INVALID error', async () => {
    const fixture = createVerifyFixture();
    const { challengeId, code } = await createdChallenge(fixture);
    const wrong = String((Number(code[0] ?? '0') + 1) % 10) + code.slice(1);

    const errors = await Promise.all([
      captureHttpsError(
        handleVerifyOtp(
          fixture.verifyDeps,
          { challengeId, code: wrong, purpose: 'sign-in', phone: PHONE },
          CONTEXT,
        ),
      ),
      captureHttpsError(
        handleVerifyOtp(
          fixture.verifyDeps,
          {
            challengeId: 'c_AAAAAAAAAAAAAAAAAAAAAA',
            code,
            purpose: 'sign-in',
            phone: PHONE,
          },
          CONTEXT,
        ),
      ),
    ]);

    for (const error of errors) {
      expect(error.code).toBe('permission-denied');
      expect(error.details).toMatchObject({ code: 'CODE_INVALID' });
      expect(error.message).not.toMatch(/wrong|expired|locked|consumed|void/i);
    }
    expect(fixture.tokens.calls).toHaveLength(0);

    const malformed = await captureHttpsError(
      handleVerifyOtp(
        fixture.verifyDeps,
        { challengeId, code, purpose: 'bogus', phone: PHONE },
        CONTEXT,
      ),
    );
    expect(malformed.code).toBe('invalid-argument');
    expect(malformed.details).toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('rejects non-sign-in purposes before touching challenge state', async () => {
    const fixture = createVerifyFixture();
    const { challengeId, code } = await createdChallenge(fixture);

    const error = await captureHttpsError(
      handleVerifyOtp(
        fixture.verifyDeps,
        { challengeId, code, purpose: 'phone-verification', phone: PHONE },
        CONTEXT,
      ),
    );

    expect(error.code).toBe('invalid-argument');
    expect(error.details).toEqual({ code: 'INVALID_REQUEST' });
    expect(await challengeRecord(fixture, challengeId)).toMatchObject({
      status: 'pending',
      attempts: 0,
    });
    expect(fixture.tokens.calls).toHaveLength(0);
  });

  it('maps verify rate limits to RATE_LIMITED', async () => {
    const fixture = createVerifyFixture({
      policy: { requesterVerifyLimit: { max: 1, windowSeconds: 600 } },
    });
    const { challengeId, code } = await createdChallenge(fixture);
    const wrong = String((Number(code[0] ?? '0') + 1) % 10) + code.slice(1);
    const first = await captureHttpsError(
      handleVerifyOtp(
        fixture.verifyDeps,
        { challengeId, code: wrong, purpose: 'sign-in', phone: PHONE },
        CONTEXT,
      ),
    );
    expect(first.details).toMatchObject({ code: 'CODE_INVALID' });

    const error = await captureHttpsError(
      handleVerifyOtp(
        fixture.verifyDeps,
        { challengeId, code, purpose: 'sign-in', phone: PHONE },
        CONTEXT,
      ),
    );

    expect(error.code).toBe('resource-exhausted');
    expect(error.details).toMatchObject({ code: 'RATE_LIMITED' });
    expect(fixture.tokens.calls).toHaveLength(0);
  });

  it('requires the phone argument and maps unusable phones to CODE_INVALID', async () => {
    const fixture = createVerifyFixture();
    const { challengeId, code } = await createdChallenge(fixture);

    for (const phone of [undefined, null, 'not-a-phone', '9'.repeat(10_000), 42]) {
      const error = await captureHttpsError(
        handleVerifyOtp(
          fixture.verifyDeps,
          { challengeId, code, purpose: 'sign-in', phone },
          CONTEXT,
        ),
      );
      expect(error.code).toBe('permission-denied');
      expect(error.details).toEqual({ code: 'CODE_INVALID' });
      expect(error.message).not.toMatch(/phone|identity|account/i);
    }

    const verified = await handleVerifyOtp(
      fixture.verifyDeps,
      { challengeId, code, purpose: 'sign-in', phone: REQUEST_PAYLOAD.phone },
      CONTEXT,
    );
    expect(verified).toMatchObject({ verified: true, purpose: 'sign-in' });
    expect(verified.customToken).toEqual(expect.any(String));
  });

  it('maps identity failure after consumption to IDENTITY_UNAVAILABLE and requires a fresh OTP', async () => {
    const fixture = createVerifyFixture();
    fixture.store.failAcquireClaim = true;
    const { challengeId, code } = await createdChallenge(fixture);

    const error = await captureHttpsError(
      handleVerifyOtp(
        fixture.verifyDeps,
        { challengeId, code, purpose: 'sign-in', phone: PHONE },
        CONTEXT,
      ),
    );

    expect(error.code).toBe('unavailable');
    expect(error.details).toEqual({ code: 'IDENTITY_UNAVAILABLE' });
    expect(error.message).toBe('Unable to complete sign-in right now');
    expect(fixture.tokens.calls).toHaveLength(0);
    expect(await challengeRecord(fixture, challengeId)).toMatchObject({ status: 'consumed' });
    expect(fixture.logger.toJSON()).not.toMatch(/store_unavailable|auth_unavailable|conflict_/);

    const replay = await captureHttpsError(
      handleVerifyOtp(
        fixture.verifyDeps,
        { challengeId, code, purpose: 'sign-in', phone: PHONE },
        CONTEXT,
      ),
    );
    expect(replay.details).toEqual({ code: 'CODE_INVALID' });
    expect(fixture.tokens.calls).toHaveLength(0);
    expect(fixture.audit.events.filter((event) => event.type.startsWith('token.'))).toHaveLength(0);
  });

  it('maps token minting failure to IDENTITY_UNAVAILABLE after identity success', async () => {
    const fixture = createVerifyFixture();
    fixture.tokens.fail = true;
    const { challengeId, code } = await createdChallenge(fixture);

    const error = await captureHttpsError(
      handleVerifyOtp(
        fixture.verifyDeps,
        { challengeId, code, purpose: 'sign-in', phone: PHONE },
        CONTEXT,
      ),
    );

    expect(error.code).toBe('unavailable');
    expect(error.details).toEqual({ code: 'IDENTITY_UNAVAILABLE' });
    expect(fixture.tokens.calls).toHaveLength(1);
    const uid = fixture.tokens.calls[0];
    await expect(fixture.auth.getUserByPhoneNumber(PHONE)).resolves.toMatchObject({ uid });
    expect(fixture.store.peekLink(hashPhone(fixture.pepper, PHONE))).toMatchObject({
      status: 'active',
      uid,
    });
    expect(await challengeRecord(fixture, challengeId)).toMatchObject({ status: 'consumed' });
    expect(fixture.audit.events.find((event) => event.type === 'token.issue_failed')).toMatchObject(
      { uid, outcome: 'failure', reasonCode: 'auth_unavailable' },
    );

    const serialized = fixture.logger.toJSON() + fixture.audit.toJSON();
    expect(serialized).not.toContain('9876543210');
    expect(serialized).not.toContain('+91');
    expect(serialized).not.toContain('fake-custom-token');

    const replay = await captureHttpsError(
      handleVerifyOtp(
        fixture.verifyDeps,
        { challengeId, code, purpose: 'sign-in', phone: PHONE },
        CONTEXT,
      ),
    );
    expect(replay.details).toEqual({ code: 'CODE_INVALID' });
  });
});

describe('input bounds', () => {
  it('rejects oversized externally supplied strings before expensive processing', async () => {
    const fixture = createVerifyFixture();
    const oversizedDigits = '9'.repeat(100_000);

    const requestError = await captureHttpsError(
      handleRequestOtp(fixture.engine, { phone: oversizedDigits, purpose: 'sign-in' }, CONTEXT),
    );
    expect(requestError.code).toBe('invalid-argument');
    expect(requestError.details).toEqual({ code: 'INVALID_REQUEST' });

    const verifyErrors = await Promise.all([
      captureHttpsError(
        handleVerifyOtp(
          fixture.verifyDeps,
          {
            challengeId: `c_${'A'.repeat(100_000)}`,
            code: '123456',
            purpose: 'sign-in',
            phone: PHONE,
          },
          CONTEXT,
        ),
      ),
      captureHttpsError(
        handleVerifyOtp(
          fixture.verifyDeps,
          {
            challengeId: 'c_AAAAAAAAAAAAAAAAAAAAAA',
            code: oversizedDigits,
            purpose: 'sign-in',
            phone: PHONE,
          },
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
