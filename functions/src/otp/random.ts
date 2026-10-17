import { randomBytes, randomInt } from 'node:crypto';

/**
 * All security-sensitive randomness in this service comes from the Node.js
 * CSPRNG. The unseeded JavaScript PRNG is banned by ESLint for this package
 * and by a static security test.
 */

export function generateOtpCode(length: number): string {
  if (!Number.isInteger(length) || length < 4 || length > 10) {
    throw new Error('OTP code length must be an integer between 4 and 10');
  }
  let code = '';
  for (let index = 0; index < length; index += 1) {
    code += randomInt(0, 10).toString();
  }
  return code;
}

export function generateChallengeId(): string {
  return `c_${randomBytes(16).toString('base64url')}`;
}

export function generateJobId(): string {
  return `j_${randomBytes(16).toString('base64url')}`;
}

export function generateSalt(): string {
  return randomBytes(16).toString('base64url');
}

export function generateEventId(): string {
  return `a_${randomBytes(12).toString('base64url')}`;
}

const CHALLENGE_ID_PATTERN = /^c_[A-Za-z0-9_-]{22}$/;

/** `c_` + 128 bits of base64url (22 characters). */
export const CHALLENGE_ID_LENGTH = 24;

export function isValidChallengeId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === CHALLENGE_ID_LENGTH &&
    CHALLENGE_ID_PATTERN.test(value)
  );
}

export function isValidOtpCode(value: unknown, length: number): value is string {
  return typeof value === 'string' && value.length === length && /^\d+$/.test(value);
}
