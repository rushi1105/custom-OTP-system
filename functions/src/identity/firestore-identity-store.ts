import { COLLECTIONS, docRef, type DocumentDatabase } from '../storage/types.js';
import type { IdentityStore } from './identity-store.js';
import { IDENTITY_LINK_TTL_SECONDS } from './policy.js';
import type { IdentityLinkFillResult, IdentityLinkRecord } from './types.js';

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
}
