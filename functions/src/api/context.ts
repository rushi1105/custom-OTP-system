import type { CallableRequest } from 'firebase-functions/v2/https';

import type { ApiContext } from './handlers.js';
import { hashRequester } from '../otp/hashing.js';

/**
 * Builds a pseudonymous requester identifier for rate limiting.
 *
 * Limitation (documented in docs/DECISIONS.md D-021): behind proxies or load
 * balancers, `rawRequest.ip` may be a proxy address, making IP-based limits
 * weaker. User-Agent adds little entropy. Callable requests do not carry a
 * verified app identity in Phase 2 (no App Check, no auth); the phone-number
 * and global limits therefore carry the abuse-prevention weight.
 */
export function buildRequestContext(pepper: string, request: CallableRequest): ApiContext {
  const ip = request.rawRequest.ip ?? 'unknown';
  const userAgentHeader = request.rawRequest.headers['user-agent'];
  const userAgent = typeof userAgentHeader === 'string' ? userAgentHeader : 'unknown';
  return { requesterHash: hashRequester(pepper, ip, userAgent) };
}
