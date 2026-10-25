import { describe, expect, it } from 'vitest';

import { MockDeliveryProvider } from '../../functions/src/delivery/mock-provider';
import { hashPhone } from '../../functions/src/otp/hashing';
import type { ChallengeRecord, RequesterStateRecord } from '../../functions/src/otp/types';
import { COLLECTIONS, docRef } from '../../functions/src/storage/types';
import {
  createEngineFixture,
  extractOtpCodeFromMessage,
  type EngineFixture,
} from '../helpers/engine-fixture';

const PHONE = '+919876543210';
const OTHER_PHONE = '+919999999999';
const REQUESTER = 'requester-phone-binding';

async function createChallenge(
  fixture: EngineFixture,
  phoneRaw: string = PHONE,
  requesterHash: string = REQUESTER,
): Promise<{ challengeId: string; code: string }> {
  const result = await fixture.engine.requestChallenge({
    phoneRaw,
    purpose: 'sign-in',
    requesterHash,
  });
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

function verify(
  fixture: EngineFixture,
  challengeId: string,
  code: string,
  phoneRaw: unknown = PHONE,
  purpose = 'sign-in',
  requesterHash = REQUESTER,
) {
  return fixture.engine.verifyChallenge({
    challengeId,
    code,
    purpose,
    phoneRaw,
    requesterHash,
  });
}

function challengeRecord(fixture: EngineFixture, challengeId: string): ChallengeRecord | undefined {
  return fixture.db.getDocument<ChallengeRecord>(docRef(COLLECTIONS.challenges, challengeId));
}

function requesterState(fixture: EngineFixture): RequesterStateRecord | undefined {
  return fixture.db.getDocument<RequesterStateRecord>(
    docRef(COLLECTIONS.requesterState, REQUESTER),
  );
}

describe('OtpEngine phone binding (ID-9)', () => {
  it('verifies with the correct phone and code', async () => {
    const fixture = createEngineFixture();
    const { challengeId, code } = await createChallenge(fixture);
    const challenge = challengeRecord(fixture, challengeId);

    expect(challenge?.phoneHash).toBe(hashPhone(fixture.pepper, PHONE));
    expect(challenge?.phoneHash).not.toBe(hashPhone(fixture.pepper, OTHER_PHONE));

    const result = await verify(fixture, challengeId, code);

    expect(result).toMatchObject({
      outcome: 'verified',
      purpose: 'sign-in',
      challengeId,
      e164: PHONE,
      phoneHash: hashPhone(fixture.pepper, PHONE),
    });
    expect(challengeRecord(fixture, challengeId)?.status).toBe('consumed');
  });

  it('rejects a wrong phone with the correct code without consuming the challenge or incrementing attempts', async () => {
    const fixture = createEngineFixture();
    const { challengeId, code } = await createChallenge(fixture);

    const result = await verify(fixture, challengeId, code, OTHER_PHONE);

    expect(result).toMatchObject({ outcome: 'invalid', internalReason: 'phone_mismatch' });
    const challenge = challengeRecord(fixture, challengeId);
    expect(challenge).toMatchObject({ status: 'pending', attempts: 0 });
    expect(challenge?.consumedAt).toBeUndefined();
    // No writes at all on mismatch: the verify window was not incremented.
    expect(requesterState(fixture)?.verifyWindowCount).toBe(0);
    const audit = fixture.audit.events.at(-1);
    expect(audit).toMatchObject({
      type: 'otp.verification.failed',
      reasonCode: 'phone_mismatch',
      outcome: 'failure',
    });
    expect(fixture.audit.toJSON()).not.toContain('9876543210');
    expect(fixture.audit.toJSON()).not.toContain('9999999999');
  });

  it('accepts canonically equivalent phone representations for the same challenge', async () => {
    const fixture = createEngineFixture();
    const forms = ['09876543210', '919876543210', ' +91 98765 43210 '];

    for (const [index, form] of forms.entries()) {
      if (index > 0) {
        fixture.clock.advanceSeconds(61);
      }
      const { challengeId, code } = await createChallenge(fixture);
      const result = await verify(fixture, challengeId, code, form);
      expect(result).toMatchObject({
        outcome: 'verified',
        purpose: 'sign-in',
        challengeId,
        e164: PHONE,
        phoneHash: hashPhone(fixture.pepper, PHONE),
      });
    }
  });

  it('rejects malformed and oversized phone input generically without changing state', async () => {
    const fixture = createEngineFixture();
    const { challengeId, code } = await createChallenge(fixture);
    const badPhones: unknown[] = [
      null,
      42,
      '',
      '   ',
      'not-a-phone',
      '+91',
      '98765432100',
      '9'.repeat(10_000),
    ];

    for (const phone of badPhones) {
      const result = await verify(fixture, challengeId, code, phone);
      expect(result).toMatchObject({ outcome: 'invalid', internalReason: 'phone_invalid' });
    }

    // The runtime boundary must reject a genuinely missing phone rather than
    // falling back to any default (the helper's default argument only applies
    // when the argument is omitted at the call site).
    const missingPhone = await fixture.engine.verifyChallenge({
      challengeId,
      code,
      purpose: 'sign-in',
      phoneRaw: undefined,
      requesterHash: REQUESTER,
    });
    expect(missingPhone).toMatchObject({ outcome: 'invalid', internalReason: 'phone_invalid' });

    const challenge = challengeRecord(fixture, challengeId);
    expect(challenge).toMatchObject({ status: 'pending', attempts: 0 });
    expect(requesterState(fixture)?.verifyWindowCount).toBe(0);

    // The challenge remains usable with the correct phone and code.
    const result = await verify(fixture, challengeId, code);
    expect(result).toMatchObject({
      outcome: 'verified',
      purpose: 'sign-in',
      challengeId,
      e164: PHONE,
      phoneHash: hashPhone(fixture.pepper, PHONE),
    });
  });

  it('keeps expiry and single-use behavior for the correct phone', async () => {
    const fixture = createEngineFixture();
    const first = await createChallenge(fixture);

    const consumed = await verify(fixture, first.challengeId, first.code);
    expect(consumed.outcome).toBe('verified');
    const replay = await verify(fixture, first.challengeId, first.code);
    expect(replay).toMatchObject({ outcome: 'invalid', internalReason: 'consumed' });

    fixture.clock.advanceSeconds(61);
    const second = await createChallenge(fixture);
    fixture.clock.advanceSeconds(301);
    const expired = await verify(fixture, second.challengeId, second.code);
    expect(expired).toMatchObject({ outcome: 'invalid', internalReason: 'expired' });
    expect(challengeRecord(fixture, second.challengeId)?.status).toBe('expired');
  });

  it('consumes exactly once under concurrent mixed-phone verification', async () => {
    const fixture = createEngineFixture();
    const { challengeId, code } = await createChallenge(fixture);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        verify(fixture, challengeId, code, index % 2 === 0 ? OTHER_PHONE : PHONE),
      ),
    );

    const verified = results.filter((result) => result.outcome === 'verified');
    const mismatches = results.filter(
      (result) => result.outcome === 'invalid' && result.internalReason === 'phone_mismatch',
    );
    const consumed = results.filter(
      (result) => result.outcome === 'invalid' && result.internalReason === 'consumed',
    );
    expect(verified).toHaveLength(1);
    expect(mismatches).toHaveLength(5);
    expect(consumed).toHaveLength(4);

    const challenge = challengeRecord(fixture, challengeId);
    expect(challenge?.status).toBe('consumed');
    expect(challenge?.attempts).toBe(0);
  });

  it('does not let phone mismatches consume the requester verify quota', async () => {
    const fixture = createEngineFixture({
      policy: { requesterVerifyLimit: { max: 2, windowSeconds: 600 } },
    });
    const { challengeId, code } = await createChallenge(fixture);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const mismatch = await verify(fixture, challengeId, code, OTHER_PHONE);
      expect(mismatch).toMatchObject({ outcome: 'invalid', internalReason: 'phone_mismatch' });
    }

    const verified = await verify(fixture, challengeId, code);
    expect(verified).toMatchObject({
      outcome: 'verified',
      purpose: 'sign-in',
      challengeId,
      e164: PHONE,
      phoneHash: hashPhone(fixture.pepper, PHONE),
    });
  });

  it('keeps wrong-code attempt counting and verification rate limits intact', async () => {
    const fixture = createEngineFixture({
      policy: { requesterVerifyLimit: { max: 2, windowSeconds: 600 } },
    });
    const { challengeId, code } = await createChallenge(fixture);

    const firstWrong = await verify(fixture, challengeId, wrongCodeFor(code));
    expect(firstWrong).toMatchObject({ outcome: 'invalid', internalReason: 'wrong_code' });
    expect(challengeRecord(fixture, challengeId)?.attempts).toBe(1);
    expect(requesterState(fixture)?.verifyWindowCount).toBe(1);

    await verify(fixture, challengeId, wrongCodeFor(code));
    expect(challengeRecord(fixture, challengeId)?.attempts).toBe(2);
    expect(requesterState(fixture)?.verifyWindowCount).toBe(2);

    const limited = await verify(fixture, challengeId, code);
    expect(limited.outcome).toBe('rate_limited');
    expect(challengeRecord(fixture, challengeId)?.status).toBe('pending');
  });
});

function wrongCodeFor(code: string): string {
  const digit = Number(code[0] ?? '0');
  return String((digit + 1) % 10) + code.slice(1);
}
