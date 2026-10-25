import { randomBytes } from 'node:crypto';

/** Opaque, unguessable creation-claim identifier (CSPRNG). */
export function generateClaimId(): string {
  return `claim_${randomBytes(16).toString('base64url')}`;
}
