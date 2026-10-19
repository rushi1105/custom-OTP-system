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
 * (Firebase adapter in subphase 3.2+; fakes in tests). No Firebase imports may
 * appear in `functions/src/identity/**` (enforced by a static test).
 */
export interface AuthPort {
  getUser(uid: string): Promise<AuthUserRecord | null>;
  getUserByPhoneNumber(e164: string): Promise<AuthUserRecord | null>;
  createUserWithPhone(e164: string): Promise<AuthUserRecord>;
  createCustomToken(uid: string): Promise<string>;
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
