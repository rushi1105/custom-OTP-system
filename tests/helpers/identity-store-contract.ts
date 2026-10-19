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

    const CLAIM_A = 'claim-a';
    const CLAIM_B = 'claim-b';
    const CLAIM_TTL_MS = 120_000;
    const CLAIM_EXPIRES_MS = NOW_MS + CLAIM_TTL_MS;

    function acquireClaim(
      overrides: Partial<{
        phoneHash: string;
        claimId: string;
        nowMs: number;
        claimExpiresAtMs: number;
        pepperVersion: number;
      }> = {},
    ) {
      return {
        phoneHash: PHONE_HASH,
        claimId: CLAIM_A,
        nowMs: NOW_MS,
        claimExpiresAtMs: CLAIM_EXPIRES_MS,
        pepperVersion: 1,
        ...overrides,
      };
    }

    function finalizeClaim(
      overrides: Partial<{
        phoneHash: string;
        claimId: string;
        uid: string;
        challengeId: string;
        pepperVersion: number;
        nowMs: number;
      }> = {},
    ) {
      return {
        phoneHash: PHONE_HASH,
        claimId: CLAIM_A,
        uid: 'uid_created',
        challengeId: 'c_challenge_1',
        pepperVersion: 1,
        nowMs: NOW_MS + 1_000,
        ...overrides,
      };
    }

    function expiredPendingLink(): IdentityLinkRecord {
      return buildIdentityLink({
        phoneHash: PHONE_HASH,
        status: 'pending_creation',
        uid: null,
        claimId: 'claim-old',
        claimedAtMs: NOW_MS - CLAIM_TTL_MS * 2,
        claimExpiresAtMs: NOW_MS - CLAIM_TTL_MS,
      });
    }

    it('acquires an absent link as a pending creation claim', async () => {
      const { store, peekLink } = await harness();

      expect(await store.acquireCreationClaim(acquireClaim())).toEqual({ outcome: 'acquired' });
      expect(await peekLink(PHONE_HASH)).toMatchObject({
        status: 'pending_creation',
        uid: null,
        claimId: CLAIM_A,
        claimedAtMs: NOW_MS,
        claimExpiresAtMs: CLAIM_EXPIRES_MS,
        lastChallengeId: null,
      });
    });

    it('reports in-progress for an unexpired claim without mutating it', async () => {
      const { store, peekLink } = await harness();
      await store.acquireCreationClaim(acquireClaim());
      const before = await peekLink(PHONE_HASH);

      expect(await store.acquireCreationClaim(acquireClaim({ claimId: CLAIM_B }))).toEqual({
        outcome: 'in_progress',
      });
      expect(await peekLink(PHONE_HASH)).toEqual(before);
    });

    it('reacquires an expired claim with a new claim id', async () => {
      const { store, peekLink } = await harness();
      await store.acquireCreationClaim(acquireClaim());
      const laterMs = CLAIM_EXPIRES_MS + 1;

      expect(
        await store.acquireCreationClaim(
          acquireClaim({
            claimId: CLAIM_B,
            nowMs: laterMs,
            claimExpiresAtMs: laterMs + CLAIM_TTL_MS,
          }),
        ),
      ).toEqual({ outcome: 'reacquired' });
      expect(await peekLink(PHONE_HASH)).toMatchObject({
        status: 'pending_creation',
        claimId: CLAIM_B,
        claimedAtMs: laterMs,
        claimExpiresAtMs: laterMs + CLAIM_TTL_MS,
      });
    });

    it('blocks a corrupt pending record without a claim id', async () => {
      const { store, seedLink } = await harness();
      await seedLink(
        buildIdentityLink({
          phoneHash: PHONE_HASH,
          status: 'pending_creation',
          uid: null,
          claimId: null,
          claimExpiresAtMs: CLAIM_EXPIRES_MS,
        }),
      );

      expect(await store.acquireCreationClaim(acquireClaim())).toEqual({
        outcome: 'blocked',
        reason: 'conflict_incomplete_link',
      });
    });

    it('returns an existing active link without overwriting it', async () => {
      const { store, seedLink, peekLink } = await harness();
      await seedLink(
        buildIdentityLink({ phoneHash: PHONE_HASH, status: 'active', uid: 'uid_existing' }),
      );
      const before = await peekLink(PHONE_HASH);

      expect(await store.acquireCreationClaim(acquireClaim())).toEqual({
        outcome: 'active',
        uid: 'uid_existing',
      });
      expect(await peekLink(PHONE_HASH)).toEqual(before);
    });

    it('blocks acquisition on a revoked link', async () => {
      const { store, seedLink } = await harness();
      await seedLink(
        buildIdentityLink({ phoneHash: PHONE_HASH, status: 'revoked', uid: 'uid_revoked' }),
      );

      expect(await store.acquireCreationClaim(acquireClaim())).toEqual({
        outcome: 'blocked',
        reason: 'conflict_link_revoked',
      });
    });

    it('blocks acquisition on an active record without a uid', async () => {
      const { store, seedLink } = await harness();
      await seedLink(buildIdentityLink({ phoneHash: PHONE_HASH, status: 'active', uid: null }));

      expect(await store.acquireCreationClaim(acquireClaim())).toEqual({
        outcome: 'blocked',
        reason: 'conflict_incomplete_link',
      });
    });

    it('finalizes its own pending claim and clears claim fields', async () => {
      const { store, peekLink } = await harness();
      await store.acquireCreationClaim(acquireClaim());

      expect(await store.finalizeCreationClaim(finalizeClaim())).toEqual({
        outcome: 'finalized',
      });
      expect(await peekLink(PHONE_HASH)).toMatchObject({
        status: 'active',
        uid: 'uid_created',
        claimId: null,
        claimedAtMs: null,
        claimExpiresAtMs: null,
        lastChallengeId: 'c_challenge_1',
        verifiedAt: new Date(NOW_MS + 1_000).toISOString(),
        createdAt: new Date(NOW_MS).toISOString(),
      });
    });

    it('rejects finalization by a different claimant and leaves the record unchanged', async () => {
      const { store, peekLink } = await harness();
      await store.acquireCreationClaim(acquireClaim());
      const before = await peekLink(PHONE_HASH);

      expect(await store.finalizeCreationClaim(finalizeClaim({ claimId: CLAIM_B }))).toEqual({
        outcome: 'claim_lost',
      });
      expect(await peekLink(PHONE_HASH)).toEqual(before);
    });

    it('rejects finalization when no record exists', async () => {
      const { store } = await harness();
      expect(await store.finalizeCreationClaim(finalizeClaim())).toEqual({
        outcome: 'claim_lost',
      });
    });

    it('allows the original claimant to finalize after expiry when no takeover occurred', async () => {
      const { store } = await harness();
      await store.acquireCreationClaim(acquireClaim());

      expect(
        await store.finalizeCreationClaim(finalizeClaim({ nowMs: CLAIM_EXPIRES_MS + 1 })),
      ).toEqual({ outcome: 'finalized' });
    });

    it('rejects the previous claimant after a takeover finalized the new claim', async () => {
      const { store, peekLink } = await harness();
      await store.acquireCreationClaim(acquireClaim());
      const laterMs = CLAIM_EXPIRES_MS + 1;
      await store.acquireCreationClaim(
        acquireClaim({
          claimId: CLAIM_B,
          nowMs: laterMs,
          claimExpiresAtMs: laterMs + CLAIM_TTL_MS,
        }),
      );

      expect(await store.finalizeCreationClaim(finalizeClaim({ nowMs: laterMs + 1 }))).toEqual({
        outcome: 'claim_lost',
      });
      expect(
        await store.finalizeCreationClaim(
          finalizeClaim({ claimId: CLAIM_B, uid: 'uid_new', nowMs: laterMs + 1 }),
        ),
      ).toEqual({ outcome: 'finalized' });
      expect((await peekLink(PHONE_HASH))?.uid).toBe('uid_new');
    });

    it('blocks finalization onto an active link for a different uid', async () => {
      const { store, seedLink, peekLink } = await harness();
      await seedLink(
        buildIdentityLink({ phoneHash: PHONE_HASH, status: 'active', uid: 'uid_existing' }),
      );
      const before = await peekLink(PHONE_HASH);

      expect(await store.finalizeCreationClaim(finalizeClaim())).toEqual({
        outcome: 'blocked',
        reason: 'conflict_uid_mismatch',
      });
      expect(await peekLink(PHONE_HASH)).toEqual(before);
    });

    it('is idempotent when the active link already points at the same uid', async () => {
      const { store, seedLink, peekLink } = await harness();
      await seedLink(
        buildIdentityLink({ phoneHash: PHONE_HASH, status: 'active', uid: 'uid_created' }),
      );
      const before = await peekLink(PHONE_HASH);

      expect(await store.finalizeCreationClaim(finalizeClaim())).toEqual({
        outcome: 'finalized',
      });
      expect(await peekLink(PHONE_HASH)).toEqual(before);
    });

    it('blocks finalization on a revoked link', async () => {
      const { store, seedLink } = await harness();
      await seedLink(
        buildIdentityLink({ phoneHash: PHONE_HASH, status: 'revoked', uid: 'uid_revoked' }),
      );

      expect(await store.finalizeCreationClaim(finalizeClaim())).toEqual({
        outcome: 'blocked',
        reason: 'conflict_link_revoked',
      });
    });

    it('releases only its own pending claim', async () => {
      const { store, peekLink } = await harness();
      await store.acquireCreationClaim(acquireClaim());

      expect(await store.releaseCreationClaim({ phoneHash: PHONE_HASH, claimId: CLAIM_B })).toEqual(
        { outcome: 'not_owner' },
      );
      expect((await peekLink(PHONE_HASH))?.claimId).toBe(CLAIM_A);

      expect(await store.releaseCreationClaim({ phoneHash: PHONE_HASH, claimId: CLAIM_A })).toEqual(
        { outcome: 'released' },
      );
      expect(await peekLink(PHONE_HASH)).toBeUndefined();
    });

    it('returns no_claim when releasing an absent record', async () => {
      const { store } = await harness();
      expect(await store.releaseCreationClaim({ phoneHash: PHONE_HASH, claimId: CLAIM_A })).toEqual(
        { outcome: 'no_claim' },
      );
    });

    it('does not release an active link', async () => {
      const { store, seedLink, peekLink } = await harness();
      await seedLink(
        buildIdentityLink({ phoneHash: PHONE_HASH, status: 'active', uid: 'uid_existing' }),
      );
      const before = await peekLink(PHONE_HASH);

      expect(await store.releaseCreationClaim({ phoneHash: PHONE_HASH, claimId: CLAIM_A })).toEqual(
        { outcome: 'not_owner' },
      );
      expect(await peekLink(PHONE_HASH)).toEqual(before);
    });

    it('serializes concurrent acquisitions to one winner', async () => {
      const { store, peekLink } = await harness();
      const results = await Promise.all([
        store.acquireCreationClaim(acquireClaim({ claimId: CLAIM_A })),
        store.acquireCreationClaim(acquireClaim({ claimId: CLAIM_B })),
      ]);

      const acquiredIndex = results.findIndex((result) => result.outcome === 'acquired');
      expect(acquiredIndex).toBeGreaterThanOrEqual(0);
      expect(results.filter((result) => result.outcome === 'in_progress')).toHaveLength(1);
      expect((await peekLink(PHONE_HASH))?.claimId).toBe(acquiredIndex === 0 ? CLAIM_A : CLAIM_B);
    });

    it('serializes concurrent takeovers of an expired claim', async () => {
      const { store, seedLink, peekLink } = await harness();
      await seedLink(expiredPendingLink());

      const results = await Promise.all([
        store.acquireCreationClaim(acquireClaim({ claimId: CLAIM_A })),
        store.acquireCreationClaim(acquireClaim({ claimId: CLAIM_B })),
      ]);

      expect(results.filter((result) => result.outcome === 'reacquired')).toHaveLength(1);
      expect(results.filter((result) => result.outcome === 'in_progress')).toHaveLength(1);
      const recordedClaimId = (await peekLink(PHONE_HASH))?.claimId;
      expect([CLAIM_A, CLAIM_B]).toContain(recordedClaimId);
      expect(recordedClaimId).not.toBe('claim-old');
    });

    it('allows a new acquisition after its own claim was released', async () => {
      const { store } = await harness();
      await store.acquireCreationClaim(acquireClaim());
      await store.releaseCreationClaim({ phoneHash: PHONE_HASH, claimId: CLAIM_A });

      expect(await store.acquireCreationClaim(acquireClaim({ claimId: CLAIM_B }))).toEqual({
        outcome: 'acquired',
      });
    });
  });
}
