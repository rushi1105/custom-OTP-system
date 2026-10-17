import type { CallableRequest } from 'firebase-functions/v2/https';

import type { ApiContext } from './handlers.js';
import { hashRequester } from '../otp/hashing.js';

const MAX_IP_LENGTH = 64;
const MAX_USER_AGENT_LENGTH = 256;

/**
 * Builds a pseudonymous requester identifier for rate limiting.
 *
 * Externally supplied values are bounded before hashing: IPs are capped at
 * 64 characters, User-Agents at 256. Missing or blank values hash as
 * `unknown` so every request still maps to a stable bucket.
 *
 * Limitation (docs/DECISIONS.md D-021): behind proxies or load balancers,
 * `rawRequest.ip` may be a proxy address, making IP-based limits weaker.
 * User-Agent adds little entropy. Callable requests do not carry a verified
 * app identity in Phase 2 (no App Check, no auth); the phone-number and global
 * limits therefore carry the abuse-prevention weight.
 */
export function buildRequestContext(pepper: string, request: CallableRequest): ApiContext {
  const rawIp = request.rawRequest.ip;
  const ip = boundedOrUnknown(rawIp, MAX_IP_LENGTH);
  const userAgentHeader = request.rawRequest.headers['user-agent'];
  const userAgent = boundedOrUnknown(
    typeof userAgentHeader === 'string' ? userAgentHeader : undefined,
    MAX_USER_AGENT_LENGTH,
  );
  return { requesterHash: hashRequester(pepper, ip, userAgent) };
}

function boundedOrUnknown(value: string | undefined, maxLength: number): string {
  if (value === undefined) {
    return 'unknown';
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return 'unknown';
  }
  return trimmed.slice(0, maxLength);
}
