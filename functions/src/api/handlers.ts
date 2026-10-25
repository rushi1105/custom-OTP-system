import { HttpsError } from 'firebase-functions/v2/https';

import type { AuditSink } from '../audit/audit-log.js';
import type { CustomTokenIssuer } from '../auth/token-issuer.js';
import { recordIdentityAudit } from '../identity/audit.js';
import type { EnsureIdentityInput, IdentityAssuranceResult } from '../identity/types.js';
import type { Logger } from '../logging.js';
import type { OtpEngine } from '../otp/engine.js';
import type { VerifyOutcome } from '../otp/types.js';

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
  readonly purpose: 'sign-in';
  readonly customToken: string;
}

export interface IdentityAssurance {
  ensureIdentity(input: EnsureIdentityInput): Promise<IdentityAssuranceResult>;
}

export interface VerifyOtpDependencies {
  readonly engine: OtpEngine;
  readonly identity: IdentityAssurance;
  readonly tokens: CustomTokenIssuer;
  readonly audit: AuditSink;
  readonly logger: Logger;
  readonly clock: () => Date;
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
  if (payload['purpose'] !== 'sign-in') {
    throw invalidRequest();
  }
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
  deps: VerifyOtpDependencies,
  data: unknown,
  context: ApiContext,
): Promise<VerifyOtpResponse> {
  if (typeof data !== 'object' || data === null) {
    throw invalidRequest();
  }
  const payload = data as Record<string, unknown>;
  if (payload['purpose'] !== 'sign-in') {
    throw invalidRequest();
  }
  const result = await deps.engine.verifyChallenge({
    challengeId: payload['challengeId'],
    code: payload['code'],
    purpose: payload['purpose'],
    phoneRaw: payload['phone'],
    requesterHash: context.requesterHash,
  });

  switch (result.outcome) {
    case 'verified':
      return completeVerification(deps, result, context);
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

async function completeVerification(
  deps: VerifyOtpDependencies,
  result: Extract<VerifyOutcome, { readonly outcome: 'verified' }>,
  context: ApiContext,
): Promise<VerifyOtpResponse> {
  let assurance: IdentityAssuranceResult;
  try {
    assurance = await deps.identity.ensureIdentity({
      e164: result.e164,
      challengeId: result.challengeId,
      purpose: result.purpose,
      requesterHash: context.requesterHash,
    });
  } catch {
    deps.logger.error('identity.unavailable', { challengeId: result.challengeId });
    throw identityUnavailable();
  }

  if (assurance.status === 'conflict' || assurance.status === 'unavailable') {
    throw identityUnavailable();
  }
  const uid = assurance.uid;

  let customToken: string;
  try {
    customToken = await deps.tokens.createCustomToken(uid);
  } catch {
    await recordTokenAudit(deps, result, context, uid, 'failure');
    deps.logger.warn('token.issue_failed', { challengeId: result.challengeId });
    throw identityUnavailable();
  }

  await recordTokenAudit(deps, result, context, uid, 'success');
  deps.logger.info('token.issued', { challengeId: result.challengeId });
  return { verified: true, purpose: 'sign-in', customToken };
}

async function recordTokenAudit(
  deps: VerifyOtpDependencies,
  result: Extract<VerifyOutcome, { readonly outcome: 'verified' }>,
  context: ApiContext,
  uid: string,
  outcome: 'success' | 'failure',
): Promise<void> {
  await recordIdentityAudit(deps.audit, deps.logger, {
    type: outcome === 'success' ? 'token.issued' : 'token.issue_failed',
    occurredAt: deps.clock().toISOString(),
    actorType: 'client',
    actorHash: context.requesterHash,
    purpose: 'sign-in',
    challengeId: result.challengeId,
    jobId: null,
    phoneHash: result.phoneHash,
    uid,
    outcome,
    reasonCode: outcome === 'success' ? null : 'auth_unavailable',
  });
}

function invalidRequest(): HttpsError {
  return new HttpsError('invalid-argument', 'Invalid request', { code: 'INVALID_REQUEST' });
}

function identityUnavailable(): HttpsError {
  return new HttpsError('unavailable', 'Unable to complete sign-in right now', {
    code: 'IDENTITY_UNAVAILABLE',
  });
}
