import { HttpsError } from 'firebase-functions/v2/https';

import type { OtpEngine } from '../otp/engine.js';

export interface ApiContext {
  readonly requesterHash: string;
}

export interface RequestOtpResponse {
  readonly challengeId: string;
  readonly expiresInSeconds: number;
  readonly resendAfterSeconds: number;
}

export interface VerifyOtpResponse {
  readonly verified: true;
  readonly purpose: string;
}

export async function handleRequestOtp(
  engine: OtpEngine,
  data: unknown,
  context: ApiContext,
): Promise<RequestOtpResponse> {
  if (typeof data !== 'object' || data === null) {
    throw invalidRequest();
  }
  const payload = data as Record<string, unknown>;
  const result = await engine.requestChallenge({
    phoneRaw: payload['phone'],
    purpose: payload['purpose'],
    requesterHash: context.requesterHash,
  });

  switch (result.outcome) {
    case 'created':
      return {
        challengeId: result.challengeId,
        expiresInSeconds: result.expiresInSeconds,
        resendAfterSeconds: result.resendAfterSeconds,
      };
    case 'invalid_input':
      throw invalidRequest();
    case 'resend_cooldown':
      throw new HttpsError('resource-exhausted', 'Please wait before requesting a new code', {
        code: 'RESEND_COOLDOWN',
        retryAfterSeconds: result.retryAfterSeconds,
      });
    case 'rate_limited':
      throw new HttpsError('resource-exhausted', 'Too many requests', {
        code: 'RATE_LIMITED',
        retryAfterSeconds: result.retryAfterSeconds,
      });
    case 'delivery_unavailable':
      throw new HttpsError('unavailable', 'Delivery is temporarily unavailable', {
        code: 'SERVICE_UNAVAILABLE',
        retryAfterSeconds: result.retryAfterSeconds,
      });
  }
}

export async function handleVerifyOtp(
  engine: OtpEngine,
  data: unknown,
  context: ApiContext,
): Promise<VerifyOtpResponse> {
  if (typeof data !== 'object' || data === null) {
    throw invalidRequest();
  }
  const payload = data as Record<string, unknown>;
  const result = await engine.verifyChallenge({
    challengeId: payload['challengeId'],
    code: payload['code'],
    purpose: payload['purpose'],
    requesterHash: context.requesterHash,
  });

  switch (result.outcome) {
    case 'verified':
      return { verified: true, purpose: result.purpose };
    case 'invalid_input':
      throw invalidRequest();
    case 'invalid':
      throw new HttpsError('permission-denied', 'The code is invalid or no longer usable', {
        code: 'CODE_INVALID',
      });
    case 'rate_limited':
      throw new HttpsError('resource-exhausted', 'Too many requests', {
        code: 'RATE_LIMITED',
        retryAfterSeconds: result.retryAfterSeconds,
      });
  }
}

function invalidRequest(): HttpsError {
  return new HttpsError('invalid-argument', 'Invalid request', { code: 'INVALID_REQUEST' });
}
