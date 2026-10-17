import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DeliveryRequest } from '@otp-infra/contracts';
import { MockDeliveryProvider } from '../../functions/src/delivery/mock-provider';

const FIXED_NOW = new Date('2026-10-17T00:00:00.000Z');

function makeRequest(overrides: Partial<DeliveryRequest> = {}): DeliveryRequest {
  return {
    jobId: 'job-1',
    channel: 'sms',
    destination: '+919876543210',
    body: 'Your verification code is 123456',
    expiresAt: '2026-10-17T00:10:00.000Z',
    ...overrides,
  };
}

function makeProvider(): MockDeliveryProvider {
  return new MockDeliveryProvider({ clock: () => FIXED_NOW });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('MockDeliveryProvider', () => {
  it('accepts a valid request, returns a receipt, and records the message', async () => {
    const provider = makeProvider();

    const receipt = await provider.send(makeRequest());

    expect(receipt).toMatchObject({
      jobId: 'job-1',
      providerId: 'mock',
      status: 'accepted',
      providerMessageId: 'mock-1',
      acceptedAt: '2026-10-17T00:00:00.000Z',
    });
    expect(receipt.error).toBeUndefined();
    expect(provider.recordedMessages).toHaveLength(1);
    expect(provider.recordedMessages[0]?.destination).toBe('+919876543210');
  });

  it('rejects a destination that is not E.164 without recording it', async () => {
    const provider = makeProvider();

    const receipt = await provider.send(makeRequest({ destination: '9876543210' }));

    expect(receipt.status).toBe('rejected');
    expect(receipt.error).toMatchObject({ code: 'DESTINATION_REJECTED', retryable: false });
    expect(provider.recordedMessages).toHaveLength(0);
  });

  it('rejects a request whose expiry has already passed', async () => {
    const provider = makeProvider();

    const receipt = await provider.send(makeRequest({ expiresAt: '2026-10-16T23:59:59.000Z' }));

    expect(receipt.status).toBe('rejected');
    expect(receipt.error).toMatchObject({ code: 'INVALID_REQUEST', retryable: false });
  });

  it('reports configured downstream failures as failed with retryable metadata', async () => {
    const provider = new MockDeliveryProvider({
      clock: () => FIXED_NOW,
      failWith: {
        code: 'PROVIDER_UNAVAILABLE',
        message: 'simulated outage',
        retryable: true,
      },
    });

    const receipt = await provider.send(makeRequest());

    expect(receipt.status).toBe('failed');
    expect(receipt.error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    expect(provider.recordedMessages).toHaveLength(0);
  });

  it('reports configured rejections as rejected without recording the message', async () => {
    const provider = new MockDeliveryProvider({
      clock: () => FIXED_NOW,
      rejectWith: {
        code: 'DESTINATION_REJECTED',
        message: 'simulated rejection',
        retryable: false,
      },
    });

    const receipt = await provider.send(makeRequest());

    expect(receipt.status).toBe('rejected');
    expect(receipt.error).toMatchObject({ code: 'DESTINATION_REJECTED', retryable: false });
    expect(provider.recordedMessages).toHaveLength(0);
  });

  it('propagates configured thrown errors to simulate provider crashes', async () => {
    const provider = new MockDeliveryProvider({
      clock: () => FIXED_NOW,
      throwWith: new Error('simulated crash'),
    });

    await expect(provider.send(makeRequest())).rejects.toThrow('simulated crash');
    expect(provider.recordedMessages).toHaveLength(0);
  });

  it('does not claim confirmed handset delivery', () => {
    expect(makeProvider().capabilities.confirmedDelivery).toBe(false);
  });

  it('refuses to be instantiated in production', () => {
    vi.stubEnv('NODE_ENV', 'production');

    expect(() => new MockDeliveryProvider()).toThrow(/must never be instantiated in production/);
  });
});
