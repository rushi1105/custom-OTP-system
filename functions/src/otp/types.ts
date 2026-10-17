import type { DeliveryErrorCode } from '@otp-infra/contracts';

import type { OtpPurpose } from './policy.js';

export type ChallengeStatus = 'pending' | 'consumed' | 'expired' | 'locked' | 'void';

export type ChallengeVoidReason = 'superseded' | 'delivery_rejected' | 'delivery_failed';

export interface ChallengeRecord {
  readonly challengeId: string;
  readonly purpose: OtpPurpose;
  readonly phoneHash: string;
  readonly pepperVersion: number;
  readonly codeHash: string;
  readonly salt: string;
  readonly codeLength: number;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly status: ChallengeStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly consumedAt?: string;
  readonly lockedAt?: string;
  readonly voidedAt?: string;
  readonly voidReason?: ChallengeVoidReason;
  readonly deliveryJobId: string;
  readonly requesterHash: string;
  readonly ttlAtMs: number;
}

export interface PhoneStateRecord {
  readonly phoneHash: string;
  readonly activeChallengeId: string | null;
  readonly cooldownUntilMs: number | null;
  readonly requestWindowStartMs: number;
  readonly requestWindowCount: number;
  readonly lastRequestedAtMs: number;
  readonly ttlAtMs: number;
}

export interface RequesterStateRecord {
  readonly requesterHash: string;
  readonly requestWindowStartMs: number;
  readonly requestWindowCount: number;
  readonly verifyWindowStartMs: number;
  readonly verifyWindowCount: number;
  readonly ttlAtMs: number;
}

export interface GlobalRequestBucketRecord {
  readonly bucketKey: string;
  readonly windowStartMs: number;
  readonly count: number;
  readonly ttlAtMs: number;
}

export type DeliveryJobStatus = 'pending' | 'accepted' | 'rejected' | 'failed';

export interface DeliveryJobReceiptRecord {
  readonly providerMessageId?: string;
  readonly reportedAt: string;
  readonly errorCode?: DeliveryErrorCode;
  readonly retryable?: boolean;
}

export interface DeliveryJobRecord {
  readonly jobId: string;
  readonly challengeId: string;
  readonly providerId: string;
  readonly channel: 'sms';
  readonly status: DeliveryJobStatus;
  readonly dedupeKey: string;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly receipt?: DeliveryJobReceiptRecord;
  readonly ttlAtMs: number;
}

export type RequestOutcome =
  | {
      readonly outcome: 'created';
      readonly challengeId: string;
      readonly expiresInSeconds: number;
      readonly resendAfterSeconds: number;
    }
  | { readonly outcome: 'invalid_input' }
  | { readonly outcome: 'resend_cooldown'; readonly retryAfterSeconds: number }
  | {
      readonly outcome: 'rate_limited';
      readonly scope: 'phone' | 'requester' | 'global';
      readonly retryAfterSeconds: number;
    }
  | { readonly outcome: 'delivery_unavailable'; readonly retryAfterSeconds: number };

export type VerificationFailureReason =
  | 'wrong_code'
  | 'locked'
  | 'expired'
  | 'consumed'
  | 'voided'
  | 'not_found'
  | 'purpose_mismatch'
  | 'pepper_version_mismatch';

export type VerifyOutcome =
  | { readonly outcome: 'verified'; readonly purpose: OtpPurpose }
  | {
      readonly outcome: 'invalid';
      readonly internalReason: VerificationFailureReason;
    }
  | { readonly outcome: 'rate_limited'; readonly retryAfterSeconds: number }
  | { readonly outcome: 'invalid_input' };

export interface ChallengeRefs {
  readonly challengeId: string;
  readonly phoneHash: string;
  readonly jobId: string;
  readonly purpose: OtpPurpose;
}
