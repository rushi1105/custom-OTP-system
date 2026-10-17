export interface WindowLimit {
  readonly max: number;
  readonly windowSeconds: number;
}

export interface OtpPolicy {
  readonly codeLength: number;
  readonly ttlSeconds: number;
  readonly maxAttempts: number;
  readonly resendCooldownSeconds: number;
  readonly phoneRequestLimit: WindowLimit;
  readonly requesterRequestLimit: WindowLimit;
  readonly requesterVerifyLimit: WindowLimit;
  readonly globalRequestsPerMinute: number;
  readonly retentionSeconds: number;
  readonly auditRetentionSeconds: number;
  readonly deliveryUnavailableRetryAfterSeconds: number;
}

/**
 * Allowed challenge purposes. Both purposes share identical challenge
 * mechanics in Phase 2; downstream consequences (identity resolution, token
 * issuance) are defined in Phase 3+. The purpose is bound into the challenge
 * and code hash so a code for one purpose can never verify another.
 */
export const OTP_PURPOSES = ['sign-in', 'phone-verification'] as const;

export type OtpPurpose = (typeof OTP_PURPOSES)[number];

export function isOtpPurpose(value: unknown): value is OtpPurpose {
  return typeof value === 'string' && (OTP_PURPOSES as readonly string[]).includes(value);
}

export const DEFAULT_OTP_POLICY: OtpPolicy = Object.freeze({
  codeLength: 6,
  ttlSeconds: 300,
  maxAttempts: 5,
  resendCooldownSeconds: 60,
  phoneRequestLimit: Object.freeze({ max: 3, windowSeconds: 900 }),
  requesterRequestLimit: Object.freeze({ max: 10, windowSeconds: 600 }),
  requesterVerifyLimit: Object.freeze({ max: 20, windowSeconds: 600 }),
  globalRequestsPerMinute: 60,
  retentionSeconds: 86_400,
  auditRetentionSeconds: 7_776_000,
  deliveryUnavailableRetryAfterSeconds: 5,
});
