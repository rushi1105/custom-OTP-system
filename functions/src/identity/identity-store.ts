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
 * Persistence port for identity-link records.
 *
 * `fillActiveLink` must be transactional and guarded: it may create or refresh
 * an active link for the given UID but must never re-point, revoke, or take
 * over an existing record.
 *
 * Creation-claim operations implement docs/IDENTITY_DESIGN.md §4.3:
 * - acquire: create a claim on an absent record, reclaim only an expired claim,
 *   report an unexpired claim as in-progress, and never mutate active/revoked/
 *   corrupt records;
 * - finalize: transition the caller's own pending claim to an active link,
 *   guarded by claim id (never another claimant's record);
 * - release: delete the caller's own pending claim only (best-effort recovery
 *   after a failed creation attempt).
 */
export interface IdentityStore {
  getLink(phoneHash: string): Promise<IdentityLinkRecord | null>;

  fillActiveLink(input: {
    readonly phoneHash: string;
    readonly uid: string;
    readonly challengeId: string;
    readonly pepperVersion: number;
    readonly nowMs: number;
  }): Promise<IdentityLinkFillResult>;

  acquireCreationClaim(input: AcquireCreationClaimInput): Promise<ClaimAcquisitionResult>;

  finalizeCreationClaim(input: FinalizeCreationClaimInput): Promise<ClaimFinalizationResult>;

  releaseCreationClaim(input: ReleaseCreationClaimInput): Promise<ClaimReleaseResult>;
}
