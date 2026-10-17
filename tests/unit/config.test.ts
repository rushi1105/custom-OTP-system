import { describe, expect, it } from 'vitest';

import { loadRuntimeConfig } from '../../functions/src/config/env';
import { createDeliveryProvider } from '../../functions/src/delivery/provider-factory';
import { MockDeliveryProvider } from '../../functions/src/delivery/mock-provider';

const VALID_PEPPER = 'unit-test-pepper-0123456789abcdef0123456789abcdef';

describe('loadRuntimeConfig', () => {
  it('loads a valid configuration with defaults', () => {
    const config = loadRuntimeConfig({ OTP_HASH_PEPPER: VALID_PEPPER });
    expect(config.pepper).toBe(VALID_PEPPER);
    expect(config.pepperVersion).toBe(1);
    expect(config.deliveryProviderName).toBe('mock');
    expect(config.policy.ttlSeconds).toBe(300);
  });

  it('rejects a missing or short pepper', () => {
    expect(() => loadRuntimeConfig({})).toThrow(/OTP_HASH_PEPPER/);
    expect(() => loadRuntimeConfig({ OTP_HASH_PEPPER: 'too-short' })).toThrow(/OTP_HASH_PEPPER/);
  });

  it('rejects an invalid pepper version', () => {
    expect(() =>
      loadRuntimeConfig({ OTP_HASH_PEPPER: VALID_PEPPER, OTP_HASH_PEPPER_VERSION: 'abc' }),
    ).toThrow(/OTP_HASH_PEPPER_VERSION/);
    expect(() =>
      loadRuntimeConfig({ OTP_HASH_PEPPER: VALID_PEPPER, OTP_HASH_PEPPER_VERSION: '0' }),
    ).toThrow(/OTP_HASH_PEPPER_VERSION/);
  });
});

describe('createDeliveryProvider', () => {
  it('creates the mock provider by default and when explicitly selected', () => {
    expect(createDeliveryProvider({})).toBeInstanceOf(MockDeliveryProvider);
    expect(createDeliveryProvider({ DELIVERY_PROVIDER: 'mock' })).toBeInstanceOf(
      MockDeliveryProvider,
    );
  });

  it('fails fast for unsupported provider names', () => {
    expect(() => createDeliveryProvider({ DELIVERY_PROVIDER: 'msg91' })).toThrow(
      /Unsupported DELIVERY_PROVIDER/,
    );
    expect(() => createDeliveryProvider({ DELIVERY_PROVIDER: 'relay' })).toThrow(
      /Unsupported DELIVERY_PROVIDER/,
    );
  });

  it('refuses to construct the mock provider in production', () => {
    expect(() => createDeliveryProvider({ NODE_ENV: 'production' })).toThrow(
      /Refusing to construct the mock delivery provider/,
    );
    expect(() =>
      createDeliveryProvider({ NODE_ENV: 'production', DELIVERY_PROVIDER: 'mock' }),
    ).toThrow(/Refusing to construct the mock delivery provider/);
  });
});
