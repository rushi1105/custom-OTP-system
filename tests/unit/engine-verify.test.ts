import { describe, expect, it } from 'vitest';

import { ProviderDeliveryDispatcher } from '../../functions/src/delivery/dispatcher';
import { MockDeliveryProvider } from '../../functions/src/delivery/mock-provider';
import { OtpEngine } from '../../functions/src/otp/engine';
import { hashPhone } from '../../functions/src/otp/hashing';
import { COLLECTIONS, docRef } from '../../functions/src/storage/types';
import type { ChallengeRecord, RequesterStateRecord } from '../../functions/src/otp/types';
import {
  createEngineFixture,
  extractOtpCodeFromMessage,
  type EngineFixture,
} from '../helpers/engine-fixture';

const PHONE = '+919876543210';
const REQUESTER = 'requester-1';

function wrongCodeFor(code: string): string {
  const digit = Number(code[0] ?? '0');
  return String((digit + 1) % 10) + code.slice(1);
}

async function createChallenge(
  fixture: EngineFixture,
  phoneRaw: unknown = PHONE,
  requesterHash: string = REQUESTER,
  purpose: unknown = 'sign-in',
): Promise<{ challengeId: string; code: string }> {
  const result = await fixture.engine.requestChallenge({ phoneRaw, purpose, requesterHash });
  if (result.outcome !== 'created') {
    throw new Error(`expected challenge creation, got ${result.outcome}`);
  }
  const messages =
    fixture.provider instanceof MockDeliveryProvider ? fixture.provider.recordedMessages : [];
  const message = messages.at(-1);
  if (message === undefined) {
    throw new Error('provider did not record a message');
  }
  return { challengeId: result.challengeId, code: extractOtpCodeFromMessage(message.body) };
}

function verify(fixture: EngineFixture, challengeId: string, code: string, purpose = 'sign-in') {
  return fixture.engine.verifyChallenge({
    challengeId,
    code,
    purpose,
    requesterHash: REQUESTER,
  });
}

describe('OtpEngine.verifyChallenge', () => {
  it('verifies the correct code and consumes the challenge exactly once', async () => {
    const fixture = createEngineFixture();
    const { challengeId, code } = await createChallenge(fixture);

    const result = await verify(fixture, challengeId, code);

    expect(result).toEqual({ outcome: 'verified', purpose: 'sign-in' });
    const challenge = fixture.db.getDocument<ChallengeRecord>(
      docRef(COLLECTIONS.challenges, challengeId),
    );
    expect(challenge?.status).toBe('consumed');
    expect(challenge?.consumedAt).toBeDefined();
    expect(fixture.audit.events.at(-1)).toMatchObject({
      type: 'otp.verification.succeeded',
      outcome: 'success',
      phoneHash: hashPhone(fixture.pepper, PHONE),
    });
  });

  it('rejects a wrong code and increments attempts', async () => {
    const fixture = createEngineFixture();
    const { challengeId, code } = await createChallenge(fixture);

    const result = await verify(fixture, challengeId, wrongCodeFor(code));

    expect(result).toMatchObject({ outcome: 'invalid', internalReason: 'wrong_code' });
    const challenge = fixture.db.getDocument<ChallengeRecord>(
      docRef(COLLECTIONS.challenges, challengeId),
    );
    expect(challenge).toMatchObject({ status: 'pending', attempts: 1 });
  });

  it('rejects replay of a consumed challenge', async () => {
    const fixture = createEngineFixture();
    const { challengeId, code } = await createChallenge(fixture);
    await verify(fixture, challengeId, code);

    const replay = await verify(fixture, challengeId, code);

    expect(replay).toMatchObject({ outcome: 'invalid', internalReason: 'consumed' });
  });

  it('locks the challenge after the attempt limit and rejects the correct code afterwards', async () => {
    const fixture = createEngineFixture();
    const { challengeId, code } = await createChallenge(fixture);
    const wrong = wrongCodeFor(code);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = await verify(fixture, challengeId, wrong);
      expect(result).toMatchObject({ outcome: 'invalid', internalReason: 'wrong_code' });
    }
    const fifth = await verify(fixture, challengeId, wrong);
    expect(fifth).toMatchObject({ outcome: 'invalid', internalReason: 'locked' });

    const afterLock = await verify(fixture, challengeId, code);
    expect(afterLock).toMatchObject({ outcome: 'invalid', internalReason: 'locked' });

    const challenge = fixture.db.getDocument<ChallengeRecord>(
      docRef(COLLECTIONS.challenges, challengeId),
    );
    expect(challenge).toMatchObject({ status: 'locked', attempts: 5 });
    expect(challenge?.lockedAt).toBeDefined();
    expect(fixture.audit.events.some((event) => event.type === 'otp.challenge.locked')).toBe(true);
  });

  it('rejects an expired challenge and marks it expired', async () => {
    const fixture = createEngineFixture();
    const { challengeId, code } = await createChallenge(fixture);

    fixture.clock.advanceSeconds(301);
    const result = await verify(fixture, challengeId, code);

    expect(result).toMatchObject({ outcome: 'invalid', internalReason: 'expired' });
    const challenge = fixture.db.getDocument<ChallengeRecord>(
      docRef(COLLECTIONS.challenges, challengeId),
    );
    expect(challenge?.status).toBe('expired');

    const again = await verify(fixture, challengeId, code);
    expect(again).toMatchObject({ outcome: 'invalid', internalReason: 'expired' });
  });

  it('treats a correct code submitted at the exact expiry boundary as expired', async () => {
    const fixture = createEngineFixture();
    const { challengeId, code } = await createChallenge(fixture);

    fixture.clock.advanceSeconds(300);
    const result = await verify(fixture, challengeId, code);

    expect(result).toMatchObject({ outcome: 'invalid', internalReason: 'expired' });
  });

  it('binds the challenge to its purpose', async () => {
    const fixture = createEngineFixture();
    const { challengeId, code } = await createChallenge(
      fixture,
      PHONE,
      REQUESTER,
      'phone-verification',
    );

    const mismatch = await verify(fixture, challengeId, code, 'sign-in');
    expect(mismatch).toMatchObject({ outcome: 'invalid', internalReason: 'purpose_mismatch' });

    const correctPurpose = await verify(fixture, challengeId, code, 'phone-verification');
    expect(correctPurpose).toEqual({ outcome: 'verified', purpose: 'phone-verification' });
  });

  it('binds codes to their own challenge (phone-number binding)', async () => {
    const fixture = createEngineFixture();
    fixture.clock.advanceSeconds(61);
    const first = await createChallenge(fixture, PHONE);
    const second = await createChallenge(fixture, '+919999999999', 'requester-2');

    const crossed = await verify(fixture, second.challengeId, first.code);
    expect(crossed).toMatchObject({ outcome: 'invalid', internalReason: 'wrong_code' });

    const correctSecond = await verify(fixture, second.challengeId, second.code);
    expect(correctSecond.outcome).toBe('verified');
  });

  it('returns a generic invalid outcome for unknown challenges', async () => {
    const fixture = createEngineFixture();

    const result = await verify(fixture, 'c_AAAAAAAAAAAAAAAAAAAAAA', '123456');

    expect(result).toMatchObject({ outcome: 'invalid', internalReason: 'not_found' });
  });

  it('rejects malformed input without touching the database', async () => {
    const fixture = createEngineFixture();

    expect(await verify(fixture, 'not-a-challenge-id', '123456')).toEqual({
      outcome: 'invalid_input',
    });
    expect(await verify(fixture, 'c_AAAAAAAAAAAAAAAAAAAAAA', 'abcdef')).toEqual({
      outcome: 'invalid_input',
    });
    expect(
      await fixture.engine.verifyChallenge({
        challengeId: 'c_AAAAAAAAAAAAAAAAAAAAAA',
        code: '123456',
        purpose: 'bogus',
        requesterHash: REQUESTER,
      }),
    ).toEqual({ outcome: 'invalid_input' });
    expect(fixture.db.countCollection(COLLECTIONS.challenges)).toBe(0);
  });

  it('rate limits verification attempts and recovers after the window', async () => {
    const fixture = createEngineFixture({
      policy: {
        requesterVerifyLimit: { max: 3, windowSeconds: 600 },
        ttlSeconds: 3600,
      },
    });
    const { challengeId, code } = await createChallenge(fixture);
    const wrong = wrongCodeFor(code);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await verify(fixture, challengeId, wrong);
      expect(result).toMatchObject({ outcome: 'invalid', internalReason: 'wrong_code' });
    }
    const limited = await verify(fixture, challengeId, code);
    expect(limited.outcome).toBe('rate_limited');
    if (limited.outcome === 'rate_limited') {
      expect(limited.retryAfterSeconds).toBeGreaterThan(0);
    }

    const state = fixture.db.getDocument<RequesterStateRecord>(
      docRef(COLLECTIONS.requesterState, REQUESTER),
    );
    expect(state?.verifyWindowCount).toBe(3);

    fixture.clock.advanceSeconds(601);
    const recovered = await verify(fixture, challengeId, code);
    expect(recovered.outcome).toBe('verified');
  });

  it('consumes exactly once when many verifications race concurrently', async () => {
    const fixture = createEngineFixture();
    const { challengeId, code } = await createChallenge(fixture);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => verify(fixture, challengeId, code)),
    );

    const verified = results.filter((result) => result.outcome === 'verified');
    const invalid = results.filter((result) => result.outcome === 'invalid');
    expect(verified).toHaveLength(1);
    expect(invalid).toHaveLength(9);
    for (const result of invalid) {
      expect(result).toMatchObject({ internalReason: 'consumed' });
    }

    const challenge = fixture.db.getDocument<ChallengeRecord>(
      docRef(COLLECTIONS.challenges, challengeId),
    );
    expect(challenge?.status).toBe('consumed');
  });

  it('rejects verification after a pepper version rotation', async () => {
    const fixture = createEngineFixture();
    const { challengeId, code } = await createChallenge(fixture);

    const rotatedEngine = new OtpEngine({
      db: fixture.db,
      dispatcher: new ProviderDeliveryDispatcher(fixture.provider, fixture.db, fixture.logger, () =>
        fixture.clock.now(),
      ),
      clock: () => fixture.clock.now(),
      logger: fixture.logger,
      audit: fixture.audit,
      policy: fixture.policy,
      pepper: fixture.pepper,
      pepperVersion: fixture.pepperVersion + 1,
    });

    const result = await rotatedEngine.verifyChallenge({
      challengeId,
      code,
      purpose: 'sign-in',
      requesterHash: REQUESTER,
    });

    expect(result).toMatchObject({
      outcome: 'invalid',
      internalReason: 'pepper_version_mismatch',
    });
  });

  it('keeps codes, phone numbers and challenge secrets out of logs and audit events', async () => {
    const fixture = createEngineFixture();
    const { challengeId, code } = await createChallenge(fixture);
    await verify(fixture, challengeId, wrongCodeFor(code));
    await verify(fixture, challengeId, code);
    await verify(fixture, challengeId, code);

    const logs = fixture.logger.toJSON();
    const audit = fixture.audit.toJSON();
    for (const serialized of [logs, audit]) {
      expect(serialized).not.toContain(code);
      expect(serialized).not.toContain('9876543210');
      expect(serialized).not.toContain('+919876543210');
    }
    for (const event of fixture.audit.events) {
      expect(event.phoneHash === null || /^[0-9a-f]{64}$/.test(event.phoneHash)).toBe(true);
    }
  });
});
