import type { IdentityFailureReason } from './errors.js';

export type IdentityLinkStatus = 'pending_creation' | 'active' | 'revoked';

/**
 * Backend-owned cache/claim/recovery record (docs/IDENTITY_DESIGN.md §8).
 * Never independent authority over Firebase identity; never client-readable.
 */
export interface IdentityLinkRecord {
  readonly phoneHash: string;
  readonly status: IdentityLinkStatus;
  readonly uid: string | null;
  readonly claimId: string | null;
  readonly claimedAtMs: number | null;
  readonly claimExpiresAtMs: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly verifiedAt: string | null;
  readonly lastChallengeId: string | null;
  readonly pepperVersion: number;
  readonly ttlAtMs: number;
}

/** Minimal Auth projection; never contains tokens or claims. */
export interface AuthUserRecord {
  readonly uid: string;
  readonly phoneNumber: string | null;
  readonly disabled: boolean;
}

/**
 * Provider-agnostic Auth port. Implementations live outside the domain layer
 * (Firebase adapter in subphase 3.3c; fakes in tests). No Firebase imports may
 * appear in `functions/src/identity/**` (enforced by a static test).
 *
 * Token minting is intentionally separate (`CustomTokenIssuer` in the Auth
 * adapter) and must not enter the identity domain.
 */
export interface AuthPort {
  getUser(uid: string): Promise<AuthUserRecord | null>;
  getUserByPhoneNumber(e164: string): Promise<AuthUserRecord | null>;
  createUserWithPhone(e164: string): Promise<AuthUserRecord>;
}

export interface ResolveExistingIdentityInput {
  /** Canonical E.164, admitted only through the ID-9 challenge binding. */
  readonly e164: string;
  readonly challengeId: string;
}

export type IdentityResolutionSource = 'link' | 'auth';

/**
 * Resolution result for existing identities (subphase 3.1/3.2). `not_found`
 * means no authoritative identity owns the phone; the creation flow (3.3)
 * decides whether a new user may be created.
 */
export type IdentityResolutionResult =
  | { readonly status: 'resolved'; readonly uid: string; readonly source: IdentityResolutionSource }
  | { readonly status: 'not_found' }
  | { readonly status: 'conflict'; readonly reason: IdentityFailureReason }
  | { readonly status: 'unavailable'; readonly reason: IdentityFailureReason };

export type IdentityLinkFillResult =
  | { readonly outcome: 'filled' }
  | { readonly outcome: 'refreshed' }
  | { readonly outcome: 'conflict'; readonly reason: IdentityFailureReason };

export interface EnsureIdentityInput {
  /** Canonical E.164 admitted only through the ID-9 challenge binding. */
  readonly e164: string;
  readonly challengeId: string;
  /** Phase 3 creation is restricted to the `sign-in` purpose. */
  readonly purpose: string;
  readonly requesterHash: string | null;
}

/**
 * Internal result of the creation orchestration (wired to the callable response
 * in Phase 3.4). `recovered` means an existing Auth user was found during
 * claim recovery/finalization; no user was created by this attempt.
 */
export type IdentityAssuranceResult =
  | {
      readonly status: 'resolved';
      readonly uid: string;
      readonly source: IdentityResolutionSource;
    }
  | { readonly status: 'created'; readonly uid: string }
  | { readonly status: 'recovered'; readonly uid: string }
  | { readonly status: 'conflict'; readonly reason: IdentityFailureReason }
  | { readonly status: 'unavailable'; readonly reason: IdentityFailureReason };

export interface AcquireCreationClaimInput {
  readonly phoneHash: string;
  readonly claimId: string;
  readonly nowMs: number;
  readonly claimExpiresAtMs: number;
  readonly pepperVersion: number;
}

export type ClaimAcquisitionResult =
  /** Claim created on an absent record. */
  | { readonly outcome: 'acquired' }
  /** Expired claim replaced by this claimant (caller must re-check Auth first). */
  | { readonly outcome: 'reacquired' }
  /** Another unexpired claim is held; caller retries within its budget. */
  | { readonly outcome: 'in_progress' }
  /** The link is already active; resolve instead of creating. */
  | { readonly outcome: 'active'; readonly uid: string }
  /** Revoked or corrupt record; fail closed without mutation. */
  | { readonly outcome: 'blocked'; readonly reason: IdentityFailureReason };

export interface FinalizeCreationClaimInput {
  readonly phoneHash: string;
  readonly claimId: string;
  readonly uid: string;
  readonly challengeId: string;
  readonly pepperVersion: number;
  readonly nowMs: number;
}

export type ClaimFinalizationResult =
  | { readonly outcome: 'finalized' }
  /** The claim is absent, or was taken over by another claimant. */
  | { readonly outcome: 'claim_lost' }
  /** The record is revoked/corrupt or active for a different UID. */
  | { readonly outcome: 'blocked'; readonly reason: IdentityFailureReason };

export interface ReleaseCreationClaimInput {
  readonly phoneHash: string;
  readonly claimId: string;
}

export type ClaimReleaseResult =
  | { readonly outcome: 'released' }
  /** The record exists but is not this claimant's pending claim. */
  | { readonly outcome: 'not_owner' }
  /** No record exists for this phone hash. */
  | { readonly outcome: 'no_claim' };
