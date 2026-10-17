import type { DeliveryProvider } from '@otp-infra/contracts';

import { MockDeliveryProvider } from './mock-provider.js';

export const SUPPORTED_PROVIDER_NAMES = ['mock'] as const;

/**
 * Phase 2 supports only the mock delivery provider. Any other configuration
 * fails fast so a misconfigured environment can never silently send through an
 * unintended channel.
 */
export function createDeliveryProvider(
  env: NodeJS.ProcessEnv,
  clock?: () => Date,
): DeliveryProvider {
  const providerName = env.DELIVERY_PROVIDER ?? 'mock';
  if (providerName !== 'mock') {
    throw new Error(
      `Unsupported DELIVERY_PROVIDER "${providerName}"; Phase 2 supports only: ${SUPPORTED_PROVIDER_NAMES.join(', ')}`,
    );
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('Refusing to construct the mock delivery provider in a production environment');
  }
  return new MockDeliveryProvider(clock ? { clock } : {});
}
