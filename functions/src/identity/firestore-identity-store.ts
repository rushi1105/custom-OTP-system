import { COLLECTIONS, docRef, type DocumentDatabase } from '../storage/types.js';
import { isPendingCreationClaimActive } from './claims.js';
import type { IdentityStore } from './identity-store.js';
import { IDENTITY_LINK_TTL_SECONDS } from './policy.js';
import type {
  AcquireCreationClaimInput,
  ClaimAcquisitionResult,
  ClaimFinalizationResult,
  ClaimReleaseResult,
  FinalizeCreationClaimInput,
  IdentityLinkFillResult,
  IdentityLinkRecord,
  ReleaseCreationClaimInput,
} from './types.js';

/**
 * Firestore-backed IdentityStore adapter (Phase 3.2).
 *
 * Firebase-specific coupling stays in the storage layer (`DocumentDatabase` is
 * implemented by FirestoreDocumentDatabase outside this module); this adapter
 * only composes the port contract over that abstraction, so it can be exercised
 * with the in-memory database and the Firestore emulator.
 *
 * Invariants (shared contract):
 * - fill may create or refresh an active link for the same UID only;
 * - it never re-points, takes over pending/expired claims, or overwrites
 *   revoked/incomplete/conflicting records;
 * - guarded reads/writes run in a transaction, so concurrent fills serialize
 *   and retries cannot violate the invariants.
 */
export class FirestoreIdentityStore implements IdentityStore {
  private readonly db: DocumentDatabase;

  constructor(db: DocumentDatabase) {
    this.db = db;
  }

  async getLink(phoneHash: string): Promise<IdentityLinkRecord | null> {
    const snapshot = await this.db.get<IdentityLinkRecord>(
      docRef(COLLECTIONS.identityLinks, phoneHash),
    );
    return snapshot === null ? null : snapshot.data;
  }

  async fillActiveLink(input: {
    readonly phoneHash: string;
    readonly uid: string;
    readonly challengeId: string;
    readonly pepperVersion: number;
    readonly nowMs: number;
  }): Promise<IdentityLinkFillResult> {
    return this.db.runTransaction<IdentityLinkFillResult>(async (tx) => {
      const ref = docRef(COLLECTIONS.identityLinks, input.phoneHash);
      const snapshot = await tx.read<IdentityLinkRecord>(ref);
      const nowIso = new Date(input.nowMs).toISOString();

      if (snapshot === null) {
        const record: IdentityLinkRecord = {
          phoneHash: input.phoneHash,
          status: 'active',
          uid: input.uid,
          claimId: null,
          claimedAtMs: null,
          claimExpiresAtMs: null,
          createdAt: nowIso,
          updatedAt: nowIso,
          verifiedAt: nowIso,
          lastChallengeId: input.challengeId,
          pepperVersion: input.pepperVersion,
          ttlAtMs: input.nowMs + IDENTITY_LINK_TTL_SECONDS * 1000,
        };
        tx.write(ref, record);
        return { outcome: 'filled' };
      }

      const existing = snapshot.data;
      if (existing.status === 'revoked') {
        return { outcome: 'conflict', reason: 'conflict_link_revoked' };
      }
      if (existing.status === 'pending_creation') {
        return { outcome: 'conflict', reason: 'claim_pending' };
      }
      if (existing.uid !== input.uid) {
        return { outcome: 'conflict', reason: 'conflict_uid_mismatch' };
      }

      tx.write(ref, {
        ...existing,
        updatedAt: nowIso,
        verifiedAt: nowIso,
        lastChallengeId: input.challengeId,
        pepperVersion: input.pepperVersion,
      } satisfies IdentityLinkRecord);
      return { outcome: 'refreshed' };
    });
  }

  async acquireCreationClaim(input: AcquireCreationClaimInput): Promise<ClaimAcquisitionResult> {
    return this.db.runTransaction<ClaimAcquisitionResult>(async (tx) => {
      const ref = docRef(COLLECTIONS.identityLinks, input.phoneHash);
      const snapshot = await tx.read<IdentityLinkRecord>(ref);
      const nowIso = new Date(input.nowMs).toISOString();

      if (snapshot === null) {
        tx.write(ref, {
          phoneHash: input.phoneHash,
          status: 'pending_creation',
          uid: null,
          claimId: input.claimId,
          claimedAtMs: input.nowMs,
          claimExpiresAtMs: input.claimExpiresAtMs,
          createdAt: nowIso,
          updatedAt: nowIso,
          verifiedAt: null,
          lastChallengeId: null,
          pepperVersion: input.pepperVersion,
          ttlAtMs: input.nowMs + IDENTITY_LINK_TTL_SECONDS * 1000,
        } satisfies IdentityLinkRecord);
        return { outcome: 'acquired' };
      }

      const existing = snapshot.data;
      if (existing.status === 'revoked') {
        return { outcome: 'blocked', reason: 'conflict_link_revoked' };
      }
      if (existing.status === 'active') {
        if (existing.uid === null) {
          return { outcome: 'blocked', reason: 'conflict_incomplete_link' };
        }
        return { outcome: 'active', uid: existing.uid };
      }
      if (existing.status === 'pending_creation') {
        if (existing.claimId === null) {
          return { outcome: 'blocked', reason: 'conflict_incomplete_link' };
        }
        if (isPendingCreationClaimActive(existing, input.nowMs)) {
          return { outcome: 'in_progress' };
        }
        tx.write(ref, {
          ...existing,
          claimId: input.claimId,
          claimedAtMs: input.nowMs,
          claimExpiresAtMs: input.claimExpiresAtMs,
          updatedAt: nowIso,
          pepperVersion: input.pepperVersion,
        } satisfies IdentityLinkRecord);
        return { outcome: 'reacquired' };
      }
      return { outcome: 'blocked', reason: 'conflict_incomplete_link' };
    });
  }

  async finalizeCreationClaim(input: FinalizeCreationClaimInput): Promise<ClaimFinalizationResult> {
    return this.db.runTransaction<ClaimFinalizationResult>(async (tx) => {
      const ref = docRef(COLLECTIONS.identityLinks, input.phoneHash);
      const snapshot = await tx.read<IdentityLinkRecord>(ref);
      if (snapshot === null) {
        return { outcome: 'claim_lost' };
      }

      const existing = snapshot.data;
      if (existing.status === 'active') {
        return existing.uid === input.uid
          ? { outcome: 'finalized' }
          : { outcome: 'blocked', reason: 'conflict_uid_mismatch' };
      }
      if (existing.status === 'revoked') {
        return { outcome: 'blocked', reason: 'conflict_link_revoked' };
      }
      if (existing.status !== 'pending_creation' || existing.claimId === null) {
        return { outcome: 'blocked', reason: 'conflict_incomplete_link' };
      }
      if (existing.claimId !== input.claimId) {
        return { outcome: 'claim_lost' };
      }

      const nowIso = new Date(input.nowMs).toISOString();
      tx.write(ref, {
        ...existing,
        status: 'active',
        uid: input.uid,
        claimId: null,
        claimedAtMs: null,
        claimExpiresAtMs: null,
        updatedAt: nowIso,
        verifiedAt: nowIso,
        lastChallengeId: input.challengeId,
        pepperVersion: input.pepperVersion,
      } satisfies IdentityLinkRecord);
      return { outcome: 'finalized' };
    });
  }

  async releaseCreationClaim(input: ReleaseCreationClaimInput): Promise<ClaimReleaseResult> {
    return this.db.runTransaction<ClaimReleaseResult>(async (tx) => {
      const ref = docRef(COLLECTIONS.identityLinks, input.phoneHash);
      const snapshot = await tx.read<IdentityLinkRecord>(ref);
      if (snapshot === null) {
        return { outcome: 'no_claim' };
      }

      const existing = snapshot.data;
      if (
        existing.status !== 'pending_creation' ||
        existing.claimId === null ||
        existing.claimId !== input.claimId
      ) {
        return { outcome: 'not_owner' };
      }

      tx.delete(ref);
      return { outcome: 'released' };
    });
  }
}
