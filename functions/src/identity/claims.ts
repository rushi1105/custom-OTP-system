import type { IdentityLinkRecord } from './types.js';

/**
 * Pure claim-state helpers shared by the resolver (3.1/3.2) and the creation
 * protocol (3.3). A `pending_creation` link without an expiry is treated as
 * expired so a crashed or malformed claim can be reclaimed; callers that need
 * fail-closed behavior for malformed records check `claimId` separately.
 */
export function isPendingCreationClaimActive(link: IdentityLinkRecord, nowMs: number): boolean {
  return (
    link.status === 'pending_creation' &&
    link.claimExpiresAtMs !== null &&
    link.claimExpiresAtMs > nowMs
  );
}

export function isPendingCreationClaimExpired(link: IdentityLinkRecord, nowMs: number): boolean {
  return (
    link.status === 'pending_creation' &&
    (link.claimExpiresAtMs === null || link.claimExpiresAtMs <= nowMs)
  );
}
