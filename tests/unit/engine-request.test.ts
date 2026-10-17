import { describe, expect, it } from 'vitest';

import type { DeliveryRequest } from '@otp-infra/contracts';
import { MockDeliveryProvider } from '../../functions/src/delivery/mock-provider';
import { hashPhone } from '../../functions/src/otp/hashing';
import { COLLECTIONS, docRef } from '../../functions/src/storage/types';
import type {
  ChallengeRecord,
  DeliveryJobRecord,
  PhoneStateRecord,
  RequesterStateRecord,
} from '../../functions/src/otp/types';
import {
  createEngineFixture,
  extractOtpCodeFromMessage,
  type EngineFixture,
} from '../helpers/engine-fixture';

const PHONE = '+919876543210';
const REQUESTER = 'requester-1';

const NINE_HUNDRED_SECONDS_MS = 900_000;

function alignedStartIso(): string {
  const base = Date.parse('2026-10-17T00:00:00.000Z');
  return new Date(
    Math.floor(base / NINE_HUNDRED_SECONDS_MS) * NINE_HUNDRED_SECONDS_MS,
  ).toISOString();
}

function request(
  fixture: EngineFixture,
  overrides: Partial<{ phoneRaw: unknown; purpose: unknown; requesterHash: string }> = {},
) {
  return fixture.engine.requestChallenge({
    phoneRaw: PHONE,
    purpose: 'sign-in',
    requesterHash: REQUESTER,
    ...overrides,
  });
}

function mockMessages(fixture: EngineFixture): readonly DeliveryRequest[] {
  return fixture.provider instanceof MockDeliveryProvider ? fixture.provider.recordedMessages : [];
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
  const message = mockMessages(fixture).at(-1);
  if (message === undefined) {
    throw new Error('provider did not record a message');
  }
  return { challengeId: result.challengeId, code: extractOtpCodeFromMessage(message.body) };
}

describe('OtpEngine.requestChallenge', () => {
  it('creates a challenge, dispatches via the mock provider, and stores no plaintext secrets', async () => {
    const fixture = createEngineFixture({ startIso: alignedStartIso() });

    const result = await request(fixture);

    expect(result.outcome).toBe('created');
    if (result.outcome !== 'created') {
      return;
    }
    expect(result.expiresInSeconds).toBe(300);
    expect(result.resendAfterSeconds).toBe(60);

    const challenge = fixture.db.getDocument<ChallengeRecord>(
      docRef(COLLECTIONS.challenges, result.challengeId),
    );
    expect(challenge).toMatchObject({
      status: 'pending',
      attempts: 0,
      maxAttempts: 5,
      purpose: 'sign-in',
      phoneHash: hashPhone(fixture.pepper, PHONE),
      pepperVersion: 1,
    });
    expect(challenge?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(challenge?.codeHash).not.toContain(
      extractOtpCodeFromMessage(mockMessages(fixture)[0]?.body ?? ''),
    );

    const job = fixture.db.getDocument<DeliveryJobRecord>(
      docRef(COLLECTIONS.deliveryJobs, challenge?.deliveryJobId ?? ''),
    );
    expect(job).toMatchObject({ status: 'accepted', attempts: 1, providerId: 'mock' });

    const message = mockMessages(fixture)[0];
    expect(message?.destination).toBe(PHONE);
    expect(message?.metadata).toEqual({ challengeId: result.challengeId, purpose: 'sign-in' });
    const code = extractOtpCodeFromMessage(message?.body ?? '');
    expect(message?.body).toContain(code);

    expect(fixture.db.dump()).not.toContain('9876543210');
    expect(fixture.logger.toJSON()).not.toContain('9876543210');
    expect(fixture.logger.toJSON()).not.toContain(code);
    expect(fixture.audit.toJSON()).not.toContain('9876543210');
    expect(fixture.audit.toJSON()).not.toContain(code);

    const auditEvent = fixture.audit.events[0];
    expect(auditEvent).toMatchObject({
      type: 'otp.request.created',
      outcome: 'success',
      phoneHash: hashPhone(fixture.pepper, PHONE),
    });
  });

  it('rejects an immediate resend with a cooldown and records no extra message', async () => {
    const fixture = createEngineFixture({ startIso: alignedStartIso() });
    await request(fixture);

    const second = await request(fixture);

    expect(second).toEqual({ outcome: 'resend_cooldown', retryAfterSeconds: 60 });
    expect(mockMessages(fixture)).toHaveLength(1);
    expect(fixture.audit.events.at(-1)).toMatchObject({
      type: 'otp.request.blocked',
      reasonCode: 'cooldown',
      outcome: 'failure',
    });
  });

  it('allows a resend after the cooldown and voids the previous pending challenge', async () => {
    const fixture = createEngineFixture({ startIso: alignedStartIso() });
    const first = await request(fixture);
    expect(first.outcome).toBe('created');
    if (first.outcome !== 'created') {
      return;
    }
    const firstCode = extractOtpCodeFromMessage(mockMessages(fixture)[0]?.body ?? '');

    fixture.clock.advanceSeconds(61);
    const second = await request(fixture);

    expect(second.outcome).toBe('created');
    if (second.outcome !== 'created') {
      return;
    }
    expect(second.challengeId).not.toBe(first.challengeId);

    const oldChallenge = fixture.db.getDocument<ChallengeRecord>(
      docRef(COLLECTIONS.challenges, first.challengeId),
    );
    expect(oldChallenge).toMatchObject({ status: 'void', voidReason: 'superseded' });

    const replay = await fixture.engine.verifyChallenge({
      challengeId: first.challengeId,
      code: firstCode,
      purpose: 'sign-in',
      requesterHash: REQUESTER,
    });
    expect(replay).toMatchObject({ outcome: 'invalid', internalReason: 'voided' });
    expect(mockMessages(fixture)).toHaveLength(2);
  });

  it('enforces the per-phone request limit across cooldowns', async () => {
    const fixture = createEngineFixture({ startIso: alignedStartIso() });
    for (let index = 0; index < 3; index += 1) {
      const result = await request(fixture);
      expect(result.outcome).toBe('created');
      fixture.clock.advanceSeconds(61);
    }

    const fourth = await request(fixture);

    expect(fourth.outcome).toBe('rate_limited');
    if (fourth.outcome !== 'rate_limited') {
      return;
    }
    expect(fourth.scope).toBe('phone');
    expect(fourth.retryAfterSeconds).toBe(717);
    expect(mockMessages(fixture)).toHaveLength(3);
  });

  it('enforces the per-requester request limit across different phone numbers', async () => {
    const fixture = createEngineFixture({ startIso: alignedStartIso() });
    for (let index = 0; index < 10; index += 1) {
      const result = await request(fixture, {
        phoneRaw: `+9198765432${String(90 + index)}`,
      });
      expect(result.outcome).toBe('created');
    }

    const blocked = await request(fixture, { phoneRaw: '+919999999999' });

    expect(blocked.outcome).toBe('rate_limited');
    if (blocked.outcome !== 'rate_limited') {
      return;
    }
    expect(blocked.scope).toBe('requester');
    expect(mockMessages(fixture)).toHaveLength(10);
  });

  it('enforces the global request limit', async () => {
    const fixture = createEngineFixture({
      startIso: alignedStartIso(),
      policy: { globalRequestsPerMinute: 2 },
    });
    for (let index = 0; index < 2; index += 1) {
      const result = await request(fixture, {
        phoneRaw: `+9198765432${String(70 + index)}`,
        requesterHash: `requester-${String(index)}`,
      });
      expect(result.outcome).toBe('created');
    }

    const blocked = await request(fixture, {
      phoneRaw: '+919999999999',
      requesterHash: 'requester-3',
    });

    expect(blocked.outcome).toBe('rate_limited');
    if (blocked.outcome !== 'rate_limited') {
      return;
    }
    expect(blocked.scope).toBe('global');
  });

  it('voids the challenge and clears cooldown when the provider rejects delivery', async () => {
    const fixture = createEngineFixture({
      startIso: alignedStartIso(),
      providerOptions: {
        rejectWith: { code: 'DESTINATION_REJECTED', message: 'rejected', retryable: false },
      },
    });

    const result = await request(fixture);

    expect(result).toEqual({ outcome: 'delivery_unavailable', retryAfterSeconds: 5 });
    const failureEvent = fixture.audit.events.find(
      (event) => event.type === 'otp.request.delivery_failed',
    );
    const challengeId = failureEvent?.challengeId ?? '';
    const challenge = fixture.db.getDocument<ChallengeRecord>(
      docRef(COLLECTIONS.challenges, challengeId),
    );
    expect(challenge).toMatchObject({ status: 'void', voidReason: 'delivery_rejected' });
    const phoneState = fixture.db.getDocument<PhoneStateRecord>(
      docRef(COLLECTIONS.phoneState, hashPhone(fixture.pepper, PHONE)),
    );
    expect(phoneState?.cooldownUntilMs).toBeNull();
    expect(fixture.db.dump()).not.toContain('9876543210');

    const immediateRetry = await request(fixture);
    expect(immediateRetry.outcome).toBe('delivery_unavailable');
  });

  it('treats a provider crash as a failed delivery and voids the challenge', async () => {
    const fixture = createEngineFixture({
      startIso: alignedStartIso(),
      providerOptions: { throwWith: new Error('boom') },
    });

    const result = await request(fixture);

    expect(result.outcome).toBe('delivery_unavailable');
    const failureEvent = fixture.audit.events.find(
      (event) => event.type === 'otp.request.delivery_failed',
    );
    expect(failureEvent).toBeDefined();
    const job = fixture.db.getDocument<DeliveryJobRecord>(
      docRef(COLLECTIONS.deliveryJobs, failureEvent?.jobId ?? ''),
    );
    expect(job).toMatchObject({
      status: 'failed',
      receipt: { errorCode: 'PROVIDER_UNAVAILABLE', retryable: true },
    });
    const challenge = fixture.db.getDocument<ChallengeRecord>(
      docRef(COLLECTIONS.challenges, failureEvent?.challengeId ?? ''),
    );
    expect(challenge).toMatchObject({ status: 'void', voidReason: 'delivery_failed' });
  });

  it('treats a transient provider failure as failed delivery with the provider error recorded', async () => {
    const fixture = createEngineFixture({
      startIso: alignedStartIso(),
      providerOptions: {
        failWith: { code: 'PROVIDER_RATE_LIMITED', message: 'slow down', retryable: true },
      },
    });

    const result = await request(fixture);

    expect(result.outcome).toBe('delivery_unavailable');
    const failureEvent = fixture.audit.events.find(
      (event) => event.type === 'otp.request.delivery_failed',
    );
    expect(failureEvent?.reasonCode).toBe('PROVIDER_RATE_LIMITED');
    const job = fixture.db.getDocument<DeliveryJobRecord>(
      docRef(COLLECTIONS.deliveryJobs, failureEvent?.jobId ?? ''),
    );
    expect(job).toMatchObject({ status: 'failed' });
    expect(job?.receipt).toMatchObject({ errorCode: 'PROVIDER_RATE_LIMITED', retryable: true });
  });

  it('does not overwrite an already-consumed previous challenge on resend', async () => {
    const fixture = createEngineFixture({ startIso: alignedStartIso() });
    const first = await createChallenge(fixture);
    const verified = await fixture.engine.verifyChallenge({
      challengeId: first.challengeId,
      code: first.code,
      purpose: 'sign-in',
      requesterHash: REQUESTER,
    });
    expect(verified.outcome).toBe('verified');

    fixture.clock.advanceSeconds(61);
    const second = await request(fixture);
    expect(second.outcome).toBe('created');

    const oldChallenge = fixture.db.getDocument<ChallengeRecord>(
      docRef(COLLECTIONS.challenges, first.challengeId),
    );
    expect(oldChallenge?.status).toBe('consumed');
  });

  it('rejects invalid phones and purposes without writing any state', async () => {
    const fixture = createEngineFixture({ startIso: alignedStartIso() });

    expect(await request(fixture, { phoneRaw: '12345' })).toEqual({ outcome: 'invalid_input' });
    expect(await request(fixture, { purpose: 'not-a-purpose' })).toEqual({
      outcome: 'invalid_input',
    });
    expect(await request(fixture, { phoneRaw: 42 })).toEqual({ outcome: 'invalid_input' });

    expect(fixture.db.countCollection(COLLECTIONS.challenges)).toBe(0);
    expect(fixture.db.countCollection(COLLECTIONS.deliveryJobs)).toBe(0);
    expect(fixture.db.countCollection(COLLECTIONS.phoneState)).toBe(0);
    expect(fixture.db.countCollection(COLLECTIONS.requesterState)).toBe(0);
    expect(mockMessages(fixture)).toHaveLength(0);
  });

  it('updates the requester state document for successful requests', async () => {
    const fixture = createEngineFixture({ startIso: alignedStartIso() });
    await request(fixture);

    const requesterState = fixture.db.getDocument<RequesterStateRecord>(
      docRef(COLLECTIONS.requesterState, REQUESTER),
    );
    expect(requesterState).toMatchObject({
      requesterHash: REQUESTER,
      requestWindowCount: 1,
      verifyWindowCount: 0,
    });
  });
});
