/**
 * Internal identity failure reasons. These never reach clients: handlers map
 * every post-verification failure to the generic `IDENTITY_UNAVAILABLE`
 * (D-031 ID-5). Reasons appear only in audit events and server logs.
 */
export type IdentityFailureReason =
  | 'conflict_link_revoked'
  | 'conflict_incomplete_link'
  | 'conflict_user_missing'
  | 'conflict_user_disabled'
  | 'conflict_phone_mismatch'
  | 'conflict_uid_mismatch'
  | 'claim_pending'
  | 'claim_expired'
  | 'auth_unavailable'
  | 'store_unavailable';

/**
 * Violations of internal invariants (a programming error, not an identity
 * outcome). Callers must not catch this as an identity failure; it indicates
 * the resolver was invoked with data that bypassed the ID-9 binding path.
 */
export class IdentityInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityInvariantError';
  }
}

export function isIdentityConflict(reason: IdentityFailureReason): boolean {
  return reason.startsWith('conflict_');
}
