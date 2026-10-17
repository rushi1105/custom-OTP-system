import type { DeliveryProvider } from '@otp-infra/contracts';

import type { OtpEnvironment } from '../config/env.js';
import { MockDeliveryProvider } from './mock-provider.js';

export const SUPPORTED_PROVIDER_NAMES = ['mock'] as const;

/**
 * Constructs the delivery provider selected by the validated runtime
 * configuration (docs/DECISIONS.md D-025).
 *
 * Defense in depth: even if a caller skips configuration validation, this
 * factory still refuses the mock provider outside local/test and refuses any
 * unknown provider name. `MockDeliveryProvider` additionally refuses to
 * construct when `NODE_ENV=production`.
 */
export function createDeliveryProvider(
  providerName: string,
  environment: OtpEnvironment,
  clock?: () => Date,
): DeliveryProvider {
  if (providerName === 'mock') {
    if (environment !== 'local' && environment !== 'test') {
      throw new Error(
        `Refusing to construct the mock delivery provider for OTP_ENVIRONMENT "${environment}"`,
      );
    }
    return new MockDeliveryProvider(clock ? { clock } : {});
  }
  throw new Error(
    `Unsupported delivery provider "${providerName}"; known providers: ${SUPPORTED_PROVIDER_NAMES.join(', ')} (mock is only valid in local/test environments)`,
  );
}
