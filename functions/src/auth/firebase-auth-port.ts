import type { Auth, UserRecord } from 'firebase-admin/auth';

import {
  AuthInvalidPhoneError,
  AuthPhoneAlreadyExistsError,
  AuthUnavailableError,
} from '../identity/errors.js';
import type { AuthPort, AuthUserRecord } from '../identity/types.js';
import type { CustomTokenIssuer } from './token-issuer.js';

const USER_NOT_FOUND = 'auth/user-not-found';
const INVALID_PHONE = 'auth/invalid-phone-number';
/** Auth-emulator-observed 2026-10-19; re-check against the test project (3.7). */
const PHONE_ALREADY_EXISTS = 'auth/phone-number-already-exists';
/** Documented alias kept as a deliberate, exact mapping (never a broad match). */
const PHONE_ALREADY_EXISTS_ALIAS = 'auth/phone-already-exists';

/**
 * Thin Firebase Admin Auth adapter for the approved AuthPort operations.
 *
 * - Lookups map user-not-found to null and preserve the disabled flag.
 * - Invalid phone numbers and duplicate phones get dedicated typed errors.
 * - Every other failure maps to AuthUnavailableError. Unknown or unrelated
 *   provider errors are never reinterpreted as duplicate-phone outcomes.
 * - No retries, no logging, no phone/token payload retention.
 * - Custom-token minting is the only token operation and uses the UID only.
 */
export class FirebaseAuthPort implements AuthPort, CustomTokenIssuer {
  private readonly auth: Auth;

  constructor(auth: Auth) {
    this.auth = auth;
  }

  async getUser(uid: string): Promise<AuthUserRecord | null> {
    try {
      return toRecord(await this.auth.getUser(uid));
    } catch (error) {
      const code = errorCodeOf(error);
      if (code === USER_NOT_FOUND) {
        return null;
      }
      throw new AuthUnavailableError('Firebase Auth user lookup failed', code);
    }
  }

  async getUserByPhoneNumber(e164: string): Promise<AuthUserRecord | null> {
    try {
      return toRecord(await this.auth.getUserByPhoneNumber(e164));
    } catch (error) {
      const code = errorCodeOf(error);
      if (code === USER_NOT_FOUND) {
        return null;
      }
      if (code === INVALID_PHONE) {
        throw new AuthInvalidPhoneError('Invalid phone number', code);
      }
      throw new AuthUnavailableError('Firebase Auth phone lookup failed', code);
    }
  }

  async createUserWithPhone(e164: string): Promise<AuthUserRecord> {
    try {
      return toRecord(await this.auth.createUser({ phoneNumber: e164 }));
    } catch (error) {
      const code = errorCodeOf(error);
      if (code === PHONE_ALREADY_EXISTS || code === PHONE_ALREADY_EXISTS_ALIAS) {
        throw new AuthPhoneAlreadyExistsError('Phone number is already registered', code);
      }
      if (code === INVALID_PHONE) {
        throw new AuthInvalidPhoneError('Invalid phone number', code);
      }
      throw new AuthUnavailableError('Firebase Auth user creation failed', code);
    }
  }

  async createCustomToken(uid: string): Promise<string> {
    try {
      return await this.auth.createCustomToken(uid);
    } catch (error) {
      throw new AuthUnavailableError('Firebase custom-token minting failed', errorCodeOf(error));
    }
  }
}

function toRecord(user: UserRecord): AuthUserRecord {
  return {
    uid: user.uid,
    phoneNumber: user.phoneNumber ?? null,
    disabled: user.disabled,
  };
}

function errorCodeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}
