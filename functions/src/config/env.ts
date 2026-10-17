import { DEFAULT_OTP_POLICY, type OtpPolicy } from '../otp/policy.js';

export interface RuntimeConfig {
  readonly pepper: string;
  readonly pepperVersion: number;
  readonly deliveryProviderName: string;
  readonly policy: OtpPolicy;
}

const MIN_PEPPER_LENGTH = 32;

export function loadRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const pepper = env.OTP_HASH_PEPPER;
  if (typeof pepper !== 'string' || pepper.length < MIN_PEPPER_LENGTH) {
    throw new Error(
      `OTP_HASH_PEPPER must be set to a random string of at least ${MIN_PEPPER_LENGTH} characters`,
    );
  }
  const pepperVersionRaw = env.OTP_HASH_PEPPER_VERSION ?? '1';
  const pepperVersion = Number.parseInt(pepperVersionRaw, 10);
  if (!Number.isInteger(pepperVersion) || pepperVersion < 1) {
    throw new Error('OTP_HASH_PEPPER_VERSION must be a positive integer');
  }
  const deliveryProviderName = env.DELIVERY_PROVIDER ?? 'mock';
  return {
    pepper,
    pepperVersion,
    deliveryProviderName,
    policy: DEFAULT_OTP_POLICY,
  };
}
