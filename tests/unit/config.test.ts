import { describe, expect, it, vi } from 'vitest';

import {
  describeOtpEnvironment,
  loadRuntimeConfig,
  resolveDeliveryProviderName,
  resolveOtpEnvironment,
} from '../../functions/src/config/env';
import { MockDeliveryProvider } from '../../functions/src/delivery/mock-provider';
import { createDeliveryProvider } from '../../functions/src/delivery/provider-factory';

const VALID_PEPPER = 'unit-test-pepper-0123456789abcdef0123456789abcdef';

describe('resolveOtpEnvironment', () => {
  it.each(['local', 'test', 'staging', 'production'])('accepts explicit "%s"', (environment) => {
    expect(resolveOtpEnvironment({ OTP_ENVIRONMENT: environment })).toBe(environment);
  });

  it('defaults to local on a plain process without deployment markers', () => {
    expect(resolveOtpEnvironment({})).toBe('local');
  });

  it('treats the Firebase emulator marker as local', () => {
    expect(resolveOtpEnvironment({ FUNCTIONS_EMULATOR: 'true' })).toBe('local');
    expect(resolveOtpEnvironment({ FUNCTIONS_EMULATOR: 'TRUE' })).toBe('local');
  });

  it.each([['K_SERVICE'], ['K_REVISION'], ['FUNCTION_NAME']])(
    'fails closed on deployed marker %s without explicit configuration',
    (marker) => {
      expect(() => resolveOtpEnvironment({ [marker]: 'some-value' })).toThrow(/OTP_ENVIRONMENT/);
    },
  );

  it('fails closed on unknown environment values', () => {
    expect(() => resolveOtpEnvironment({ OTP_ENVIRONMENT: 'prod' })).toThrow(/OTP_ENVIRONMENT/);
    expect(() => resolveOtpEnvironment({ OTP_ENVIRONMENT: 'LOCAL' })).toThrow(/OTP_ENVIRONMENT/);
    expect(() => resolveOtpEnvironment({ OTP_ENVIRONMENT: 'staging ' })).not.toThrow();
  });

  it('prefers explicit configuration over the emulator marker', () => {
    expect(resolveOtpEnvironment({ OTP_ENVIRONMENT: 'test', FUNCTIONS_EMULATOR: 'true' })).toBe(
      'test',
    );
  });
});

describe('describeOtpEnvironment', () => {
  it('reports explicit and inferred environments', () => {
    expect(describeOtpEnvironment({ OTP_ENVIRONMENT: 'staging' })).toBe('staging');
    expect(describeOtpEnvironment({ FUNCTIONS_EMULATOR: 'true' })).toBe('local');
    expect(describeOtpEnvironment({})).toBe('local');
  });

  it('reports unconfigured instead of throwing for invalid or deployed-unconfigured states', () => {
    expect(describeOtpEnvironment({ OTP_ENVIRONMENT: 'bogus' })).toBe('unconfigured');
    expect(describeOtpEnvironment({ K_SERVICE: 'otp-service' })).toBe('unconfigured');
  });
});

describe('resolveDeliveryProviderName', () => {
  it('defaults to mock only in local', () => {
    expect(resolveDeliveryProviderName({}, 'local')).toBe('mock');
    expect(resolveDeliveryProviderName({ DELIVERY_PROVIDER: 'mock' }, 'local')).toBe('mock');
    expect(resolveDeliveryProviderName({ DELIVERY_PROVIDER: ' mock ' }, 'local')).toBe('mock');
  });

  it('requires an explicit provider outside local', () => {
    for (const environment of ['test', 'staging', 'production'] as const) {
      expect(() => resolveDeliveryProviderName({}, environment)).toThrow(/DELIVERY_PROVIDER/);
    }
  });

  it('allows explicit mock in test but never in staging or production', () => {
    expect(resolveDeliveryProviderName({ DELIVERY_PROVIDER: 'mock' }, 'test')).toBe('mock');
    expect(() => resolveDeliveryProviderName({ DELIVERY_PROVIDER: 'mock' }, 'staging')).toThrow(
      /not allowed/,
    );
    expect(() => resolveDeliveryProviderName({ DELIVERY_PROVIDER: 'mock' }, 'production')).toThrow(
      /not allowed/,
    );
  });

  it('rejects unknown provider names everywhere', () => {
    for (const environment of ['local', 'test', 'staging', 'production'] as const) {
      expect(() =>
        resolveDeliveryProviderName({ DELIVERY_PROVIDER: 'relay' }, environment),
      ).toThrow(/Unsupported DELIVERY_PROVIDER/);
      expect(() =>
        resolveDeliveryProviderName({ DELIVERY_PROVIDER: 'msg91' }, environment),
      ).toThrow(/Unsupported DELIVERY_PROVIDER/);
    }
  });
});

describe('loadRuntimeConfig', () => {
  it('loads a valid local configuration with mock provider default', () => {
    const config = loadRuntimeConfig({ OTP_HASH_PEPPER: VALID_PEPPER });
    expect(config.environment).toBe('local');
    expect(config.deliveryProviderName).toBe('mock');
    expect(config.pepperVersion).toBe(1);
    expect(config.policy.ttlSeconds).toBe(300);
  });

  it('loads an explicit test configuration', () => {
    const config = loadRuntimeConfig({
      OTP_HASH_PEPPER: VALID_PEPPER,
      OTP_ENVIRONMENT: 'test',
      DELIVERY_PROVIDER: 'mock',
      OTP_HASH_PEPPER_VERSION: '3',
    });
    expect(config.environment).toBe('test');
    expect(config.deliveryProviderName).toBe('mock');
    expect(config.pepperVersion).toBe(3);
  });

  it('prefers a Secret Manager pepper override over the environment value', () => {
    const secretPepper = 'secret-manager-pepper-0123456789abcdef0123456789abcdef';
    const config = loadRuntimeConfig(
      {
        OTP_HASH_PEPPER: VALID_PEPPER,
        OTP_ENVIRONMENT: 'test',
        DELIVERY_PROVIDER: 'mock',
        OTP_HASH_PEPPER_VERSION: '2',
      },
      secretPepper,
    );
    expect(config.pepper).toBe(secretPepper);
    expect(config.pepperVersion).toBe(2);
  });

  it('fails closed when the Secret Manager pepper override is unusable', () => {
    expect(() =>
      loadRuntimeConfig({ OTP_ENVIRONMENT: 'test', DELIVERY_PROVIDER: 'mock' }, 'too-short'),
    ).toThrow(/OTP_HASH_PEPPER/);
    expect(() =>
      loadRuntimeConfig({ OTP_ENVIRONMENT: 'test', DELIVERY_PROVIDER: 'mock' }, ''),
    ).toThrow(/OTP_HASH_PEPPER/);
  });

  it('rejects deployed configurations without explicit provider selection', () => {
    expect(() =>
      loadRuntimeConfig({
        OTP_HASH_PEPPER: VALID_PEPPER,
        OTP_ENVIRONMENT: 'production',
      }),
    ).toThrow(/DELIVERY_PROVIDER/);
  });

  it('rejects mock provider selection in deployed environments', () => {
    expect(() =>
      loadRuntimeConfig({
        OTP_HASH_PEPPER: VALID_PEPPER,
        OTP_ENVIRONMENT: 'production',
        DELIVERY_PROVIDER: 'mock',
      }),
    ).toThrow(/not allowed/);
  });

  it('rejects a missing or short pepper', () => {
    expect(() => loadRuntimeConfig({})).toThrow(/OTP_HASH_PEPPER/);
    expect(() => loadRuntimeConfig({ OTP_HASH_PEPPER: 'too-short' })).toThrow(/OTP_HASH_PEPPER/);
  });

  it.each([['0'], ['01'], ['-1'], ['2abc'], ['1.5'], ['abc'], ['9999999999'], ['']])(
    'rejects malformed pepper version "%s"',
    (pepperVersion) => {
      expect(() =>
        loadRuntimeConfig({
          OTP_HASH_PEPPER: VALID_PEPPER,
          OTP_HASH_PEPPER_VERSION: pepperVersion,
        }),
      ).toThrow(/OTP_HASH_PEPPER_VERSION/);
    },
  );

  it('accepts a trimmed numeric pepper version', () => {
    expect(
      loadRuntimeConfig({ OTP_HASH_PEPPER: VALID_PEPPER, OTP_HASH_PEPPER_VERSION: ' 7 ' })
        .pepperVersion,
    ).toBe(7);
  });
});

describe('createDeliveryProvider', () => {
  it('creates the mock provider only in local and test', () => {
    expect(createDeliveryProvider('mock', 'local')).toBeInstanceOf(MockDeliveryProvider);
    expect(createDeliveryProvider('mock', 'test')).toBeInstanceOf(MockDeliveryProvider);
  });

  it('refuses mock outside local and test even when called directly', () => {
    expect(() => createDeliveryProvider('mock', 'staging')).toThrow(/OTP_ENVIRONMENT/);
    expect(() => createDeliveryProvider('mock', 'production')).toThrow(/OTP_ENVIRONMENT/);
  });

  it('refuses unknown provider names', () => {
    expect(() => createDeliveryProvider('relay', 'local')).toThrow(/Unsupported delivery provider/);
    expect(() => createDeliveryProvider('', 'local')).toThrow(/Unsupported delivery provider/);
  });

  it('keeps the defense-in-depth NODE_ENV guard on the mock provider itself', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(() => createDeliveryProvider('mock', 'local')).toThrow(
        /must never be instantiated in production/,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
