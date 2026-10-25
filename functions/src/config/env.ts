import { DEFAULT_OTP_POLICY, type OtpPolicy } from '../otp/policy.js';

export const OTP_ENVIRONMENTS = ['local', 'test', 'staging', 'production'] as const;

export type OtpEnvironment = (typeof OTP_ENVIRONMENTS)[number];

export const KNOWN_DELIVERY_PROVIDERS = ['mock'] as const;

/**
 * Runtime markers that only exist on deployed Google Cloud runtimes:
 * - `K_SERVICE` / `K_REVISION`: Cloud Run (Cloud Functions 2nd gen runs on Cloud Run)
 * - `FUNCTION_NAME`: Cloud Functions 1st gen (legacy, kept as a backstop)
 *
 * The local Firebase emulator sets `FUNCTIONS_EMULATOR=true` instead, so the two
 * sets are disjoint by design.
 */
const DEPLOYMENT_MARKERS = ['K_SERVICE', 'K_REVISION', 'FUNCTION_NAME'] as const;

export interface RuntimeConfig {
  readonly pepper: string;
  readonly pepperVersion: number;
  readonly environment: OtpEnvironment;
  readonly deliveryProviderName: string;
  readonly policy: OtpPolicy;
}

const MIN_PEPPER_LENGTH = 32;
const PEPPER_VERSION_PATTERN = /^[1-9]\d{0,8}$/;

function isOtpEnvironment(value: string): value is OtpEnvironment {
  return (OTP_ENVIRONMENTS as readonly string[]).includes(value);
}

function isEmulatorRuntime(env: NodeJS.ProcessEnv): boolean {
  return (env['FUNCTIONS_EMULATOR'] ?? '').trim().toLowerCase() === 'true';
}

function hasDeploymentMarker(env: NodeJS.ProcessEnv): boolean {
  return DEPLOYMENT_MARKERS.some((marker) => (env[marker] ?? '').trim() !== '');
}

/**
 * Resolves the effective runtime environment.
 *
 * Policy (documented in docs/DECISIONS.md D-025):
 * - `OTP_ENVIRONMENT` set: must be one of local/test/staging/production, otherwise fail closed.
 * - `OTP_ENVIRONMENT` unset + Firebase emulator marker: local.
 * - `OTP_ENVIRONMENT` unset + deployment marker: fail closed (never guess on a deployed runtime).
 * - `OTP_ENVIRONMENT` unset + no markers: local (plain developer machine / test runner).
 *
 * Limits: markers are runtime-populated values owned by the platform; a future
 * platform change could remove them. The deployment checklist (roadmap Phase 7)
 * therefore requires `OTP_ENVIRONMENT` to be set explicitly for every deployed
 * environment; markers are only a fail-closed backstop.
 */
export function resolveOtpEnvironment(env: NodeJS.ProcessEnv): OtpEnvironment {
  const raw = (env['OTP_ENVIRONMENT'] ?? '').trim();
  if (raw !== '') {
    if (!isOtpEnvironment(raw)) {
      throw new Error(
        `OTP_ENVIRONMENT must be one of: ${OTP_ENVIRONMENTS.join(', ')} (received "${raw}")`,
      );
    }
    return raw;
  }
  if (isEmulatorRuntime(env)) {
    return 'local';
  }
  if (hasDeploymentMarker(env)) {
    throw new Error(
      'Deployed runtime detected (K_SERVICE/K_REVISION/FUNCTION_NAME) but OTP_ENVIRONMENT is not set; refusing to guess. Set OTP_ENVIRONMENT explicitly.',
    );
  }
  return 'local';
}

/**
 * Non-throwing label for the health endpoint. Returns `unconfigured` when the
 * environment configuration is invalid or missing on a deployed runtime, which
 * keeps health available while surfacing misconfiguration consistently.
 */
export function describeOtpEnvironment(env: NodeJS.ProcessEnv): string {
  try {
    return resolveOtpEnvironment(env);
  } catch {
    return 'unconfigured';
  }
}

/**
 * Resolves and validates the delivery provider name.
 *
 * Policy:
 * - local  : defaults to mock; any other value must be a known provider.
 * - test   : provider must be set explicitly; mock is permitted (approved tests).
 * - staging/production : provider must be set explicitly and must not be mock.
 *
 * There is intentionally no code path where a deployed (non-local) environment
 * silently falls back to the mock provider.
 */
export function resolveDeliveryProviderName(
  env: NodeJS.ProcessEnv,
  environment: OtpEnvironment,
): string {
  const raw = (env['DELIVERY_PROVIDER'] ?? '').trim();
  if (raw === '') {
    if (environment === 'local') {
      return 'mock';
    }
    throw new Error(
      `DELIVERY_PROVIDER must be set explicitly when OTP_ENVIRONMENT is "${environment}"`,
    );
  }
  if (!(KNOWN_DELIVERY_PROVIDERS as readonly string[]).includes(raw)) {
    throw new Error(
      `Unsupported DELIVERY_PROVIDER "${raw}"; known providers: ${KNOWN_DELIVERY_PROVIDERS.join(', ')} (mock is only valid in local/test environments)`,
    );
  }
  if (raw === 'mock' && environment !== 'local' && environment !== 'test') {
    throw new Error(
      `The mock delivery provider is not allowed when OTP_ENVIRONMENT is "${environment}"`,
    );
  }
  return raw;
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv, pepperOverride?: string): RuntimeConfig {
  const pepper = pepperOverride !== undefined ? pepperOverride : env['OTP_HASH_PEPPER'];
  if (typeof pepper !== 'string' || pepper.length < MIN_PEPPER_LENGTH) {
    throw new Error(
      `OTP_HASH_PEPPER must be set to a random string of at least ${MIN_PEPPER_LENGTH} characters`,
    );
  }
  const pepperVersionRaw = (env['OTP_HASH_PEPPER_VERSION'] ?? '1').trim();
  if (!PEPPER_VERSION_PATTERN.test(pepperVersionRaw)) {
    throw new Error(
      'OTP_HASH_PEPPER_VERSION must be a positive integer with no leading zeros (e.g. "1", "2")',
    );
  }
  const environment = resolveOtpEnvironment(env);
  const deliveryProviderName = resolveDeliveryProviderName(env, environment);
  return {
    pepper,
    pepperVersion: Number(pepperVersionRaw),
    environment,
    deliveryProviderName,
    policy: DEFAULT_OTP_POLICY,
  };
}
