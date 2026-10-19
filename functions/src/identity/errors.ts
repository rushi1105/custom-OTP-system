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

/**
 * Typed Auth-port failures. Only the provider error code is retained — never
 * the provider payload — so raw phone numbers or provider internals cannot leak
 * through error messages or logs.
 */
export class AuthPortError extends Error {
  readonly authErrorCode: string | null;

  constructor(message: string, authErrorCode: string | null) {
    super(message);
    this.name = new.target.name;
    this.authErrorCode = authErrorCode;
  }
}

export class AuthPhoneAlreadyExistsError extends AuthPortError {}

export class AuthInvalidPhoneError extends AuthPortError {}

export class AuthUnavailableError extends AuthPortError {}
