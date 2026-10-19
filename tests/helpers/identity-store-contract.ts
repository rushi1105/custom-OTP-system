import { describe, expect, it } from 'vitest';

import type { IdentityStore } from '../../functions/src/identity/identity-store.js';
import { IDENTITY_LINK_TTL_SECONDS } from '../../functions/src/identity/policy.js';
import type { IdentityLinkRecord } from '../../functions/src/identity/types.js';
import { buildIdentityLink } from './identity-fakes.js';

export interface IdentityStoreHarness {
  readonly store: IdentityStore;
  seedLink(record: IdentityLinkRecord): Promise<void>;
  peekLink(phoneHash: string): Promise<IdentityLinkRecord | undefined>;
}

const PHONE_HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);
const NOW_MS = Date.parse('2026-10-17T00:00:00.000Z');

/**
 * Shared contract for IdentityStore implementations: the in-memory fake now,
 * the Firestore adapter in subphase 3.2. Guards must hold for every
 * implementation: fill may create or refresh an active link for the same UID,
 * but must never re-point, take over, or mutate conflicting/revoked records.
 */
export function describeIdentityStoreContract(
  name: string,
  createHarness: () => Promise<IdentityStoreHarness> | IdentityStoreHarness,
): void {
  describe(`IdentityStore contract: ${name}`, () => {
    const harness = async () => createHarness();

    it('returns null for unknown phones', async () => {
      const { store } = await harness();
      expect(await store.getLink(PHONE_HASH)).toBeNull();
    });

    it('fills an absent link as active and records verification metadata', async () => {
      const { store, peekLink } = await harness();

      const result = await store.fillActiveLink({
        phoneHash: PHONE_HASH,
        uid: 'uid_1',
        challengeId: 'c_challenge_1',
        pepperVersion: 2,
        nowMs: NOW_MS,
      });

      expect(result).toEqual({ outcome: 'filled' });
      const stored = await peekLink(PHONE_HASH);
      expect(stored).toMatchObject({
        status: 'active',
        uid: 'uid_1',
        claimId: null,
        lastChallengeId: 'c_challenge_1',
        pepperVersion: 2,
        verifiedAt: new Date(NOW_MS).toISOString(),
        createdAt: new Date(NOW_MS).toISOString(),
        ttlAtMs: NOW_MS + IDENTITY_LINK_TTL_SECONDS * 1000,
      });
    });

    it('refreshes an active link for the same UID without changing createdAt', async () => {
      const { store, peekLink } = await harness();
      await store.fillActiveLink({
        phoneHash: PHONE_HASH,
        uid: 'uid_1',
        challengeId: 'c_challenge_1',
        pepperVersion: 1,
        nowMs: NOW_MS,
      });
      const createdAt = (await peekLink(PHONE_HASH))?.createdAt;

      const laterMs = NOW_MS + 60_000;
      const result = await store.fillActiveLink({
        phoneHash: PHONE_HASH,
        uid: 'uid_1',
        challengeId: 'c_challenge_2',
        pepperVersion: 1,
        nowMs: laterMs,
      });

      expect(result).toEqual({ outcome: 'refreshed' });
      const stored = await peekLink(PHONE_HASH);
      expect(stored?.createdAt).toBe(createdAt);
      expect(stored).toMatchObject({
        uid: 'uid_1',
        lastChallengeId: 'c_challenge_2',
        verifiedAt: new Date(laterMs).toISOString(),
        updatedAt: new Date(laterMs).toISOString(),
      });
    });

    it('refuses to re-point an active link to a different UID and leaves it unchanged', async () => {
      const { store, peekLink } = await harness();
      await store.fillActiveLink({
        phoneHash: PHONE_HASH,
        uid: 'uid_1',
        challengeId: 'c_challenge_1',
        pepperVersion: 1,
        nowMs: NOW_MS,
      });
      const before = await peekLink(PHONE_HASH);

      const result = await store.fillActiveLink({
        phoneHash: PHONE_HASH,
        uid: 'uid_2',
        challengeId: 'c_challenge_2',
        pepperVersion: 1,
        nowMs: NOW_MS + 60_000,
      });

      expect(result).toEqual({ outcome: 'conflict', reason: 'conflict_uid_mismatch' });
      expect(await peekLink(PHONE_HASH)).toEqual(before);
    });

    it('refuses to fill over a revoked link', async () => {
      const { store, seedLink } = await harness();
      await seedLink(buildIdentityLink({ phoneHash: PHONE_HASH, status: 'revoked', uid: 'uid_1' }));

      const result = await store.fillActiveLink({
        phoneHash: PHONE_HASH,
        uid: 'uid_1',
        challengeId: 'c_challenge_1',
        pepperVersion: 1,
        nowMs: NOW_MS,
      });

      expect(result).toEqual({ outcome: 'conflict', reason: 'conflict_link_revoked' });
    });

    it('refuses to fill while a creation claim is pending', async () => {
      const { store, seedLink, peekLink } = await harness();
      await seedLink(
        buildIdentityLink({
          phoneHash: PHONE_HASH,
          status: 'pending_creation',
          uid: null,
          claimId: 'claim_1',
          claimedAtMs: NOW_MS,
          claimExpiresAtMs: NOW_MS + 120_000,
        }),
      );

      const result = await store.fillActiveLink({
        phoneHash: PHONE_HASH,
        uid: 'uid_1',
        challengeId: 'c_challenge_1',
        pepperVersion: 1,
        nowMs: NOW_MS,
      });

      expect(result).toEqual({ outcome: 'conflict', reason: 'claim_pending' });
      expect((await peekLink(PHONE_HASH))?.status).toBe('pending_creation');
    });

    it('keeps records isolated per phone hash', async () => {
      const { store, peekLink } = await harness();
      await store.fillActiveLink({
        phoneHash: PHONE_HASH,
        uid: 'uid_1',
        challengeId: 'c_challenge_1',
        pepperVersion: 1,
        nowMs: NOW_MS,
      });

      expect(await store.getLink(OTHER_HASH)).toBeNull();
      expect(await peekLink(OTHER_HASH)).toBeUndefined();
    });
  });
}
