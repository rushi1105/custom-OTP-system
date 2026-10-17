import { describe, expect, it } from 'vitest';

import { MockDeliveryProvider } from '../../functions/src/delivery/mock-provider';
import { windowStartMs } from '../../functions/src/otp/state';
import type { ChallengeRecord, GlobalRequestBucketRecord } from '../../functions/src/otp/types';
import { COLLECTIONS, docRef } from '../../functions/src/storage/types';
import {
  createEngineFixture,
  extractOtpCodeFromMessage,
  type EngineFixture,
} from '../helpers/engine-fixture';

const REQUESTER = 'requester-1';

function uniquePhone(index: number): string {
  return `+9198765432${String(70 + index)}`;
}

async function createChallenge(
  fixture: EngineFixture,
): Promise<{ challengeId: string; code: string }> {
  const result = await fixture.engine.requestChallenge({
    phoneRaw: '+919876543210',
    purpose: 'sign-in',
    requesterHash: REQUESTER,
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

describe('concurrency and rate-limit races', () => {
  it('resolves concurrent global-bucket contention to the configured cap', async () => {
    const fixture = createEngineFixture({
      policy: { globalRequestsPerMinute: 3 },
    });

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        fixture.engine.requestChallenge({
          phoneRaw: uniquePhone(index),
          purpose: 'sign-in',
          requesterHash: `race-requester-${String(index)}`,
        }),
      ),
    );

    expect(results.filter((result) => result.outcome === 'created')).toHaveLength(3);
    const limited = results.filter((result) => result.outcome === 'rate_limited');
    expect(limited).toHaveLength(3);
    for (const result of limited) {
      if (result.outcome === 'rate_limited') {
        expect(result.scope).toBe('global');
      }
    }

    const bucketKey = `req-global-${String(windowStartMs(fixture.clock.currentTimeMs, 60))}`;
    const bucket = fixture.db.getDocument<GlobalRequestBucketRecord>(
      docRef(COLLECTIONS.rateLimits, bucketKey),
    );
    expect(bucket?.count).toBe(3);
    expect(fixture.db.countCollection(COLLECTIONS.challenges)).toBe(3);
  });

  it('resolves concurrent requester-limit contention to the configured cap', async () => {
    const fixture = createEngineFixture({
      policy: { requesterRequestLimit: { max: 2, windowSeconds: 600 } },
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        fixture.engine.requestChallenge({
          phoneRaw: uniquePhone(index),
          purpose: 'sign-in',
          requesterHash: REQUESTER,
        }),
      ),
    );

    expect(results.filter((result) => result.outcome === 'created')).toHaveLength(2);
    const limited = results.filter((result) => result.outcome === 'rate_limited');
    expect(limited).toHaveLength(3);
    for (const result of limited) {
      if (result.outcome === 'rate_limited') {
        expect(result.scope).toBe('requester');
      }
    }
    expect(fixture.db.countCollection(COLLECTIONS.challenges)).toBe(2);
  });

  it('consumes exactly once under high in-memory contention (30-way race)', async () => {
    const fixture = createEngineFixture({
      policy: { requesterVerifyLimit: { max: 100, windowSeconds: 600 } },
    });
    const { challengeId, code } = await createChallenge(fixture);

    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        fixture.engine.verifyChallenge({
          challengeId,
          code,
          purpose: 'sign-in',
          requesterHash: REQUESTER,
        }),
      ),
    );

    expect(results.filter((result) => result.outcome === 'verified')).toHaveLength(1);
    expect(results.filter((result) => result.outcome === 'invalid')).toHaveLength(29);

    const challenge = fixture.db.getDocument<ChallengeRecord>(
      docRef(COLLECTIONS.challenges, challengeId),
    );
    expect(challenge?.status).toBe('consumed');
  });

  it('surfaces transaction retry exhaustion as errors without corrupting state', async () => {
    const fixture = createEngineFixture({ maxTransactionAttempts: 1 });
    const { challengeId, code } = await createChallenge(fixture);

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        fixture.engine.verifyChallenge({
          challengeId,
          code,
          purpose: 'sign-in',
          requesterHash: REQUESTER,
        }),
      ),
    );

    let verifiedCount = 0;
    const rejections: unknown[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        if (result.value.outcome === 'verified') {
          verifiedCount += 1;
        }
      } else {
        rejections.push(result.reason);
      }
    }

    expect(verifiedCount).toBe(1);
    expect(rejections.length).toBeGreaterThan(0);
    for (const rejection of rejections) {
      expect(String(rejection)).toContain('retry limit exceeded');
    }

    const challenge = fixture.db.getDocument<ChallengeRecord>(
      docRef(COLLECTIONS.challenges, challengeId),
    );
    expect(challenge?.status).toBe('consumed');

    const after = await fixture.engine.verifyChallenge({
      challengeId,
      code,
      purpose: 'sign-in',
      requesterHash: REQUESTER,
    });
    expect(after).toMatchObject({ outcome: 'invalid', internalReason: 'consumed' });
  });
});
