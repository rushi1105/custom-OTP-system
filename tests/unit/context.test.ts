import { describe, expect, it } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';

import { buildRequestContext } from '../../functions/src/api/context';
import { hashRequester } from '../../functions/src/otp/hashing';
import { TEST_PEPPER } from '../helpers/engine-fixture';

function fakeRequest(ip?: unknown, userAgent?: unknown): CallableRequest {
  const headers: Record<string, unknown> = {};
  if (userAgent !== undefined) {
    headers['user-agent'] = userAgent;
  }
  return { rawRequest: { ip, headers } } as unknown as CallableRequest;
}

describe('buildRequestContext', () => {
  it('hashes the extracted IP and User-Agent and is stable across calls', () => {
    const request = fakeRequest('203.0.113.9', 'relay-client/1.0');

    const first = buildRequestContext(TEST_PEPPER, request);
    const second = buildRequestContext(TEST_PEPPER, request);

    expect(first.requesterHash).toBe(hashRequester(TEST_PEPPER, '203.0.113.9', 'relay-client/1.0'));
    expect(first.requesterHash).toBe(second.requesterHash);
    expect(first.requesterHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('maps missing IP and User-Agent to the shared unknown bucket', () => {
    const context = buildRequestContext(TEST_PEPPER, fakeRequest());

    expect(context.requesterHash).toBe(hashRequester(TEST_PEPPER, 'unknown', 'unknown'));
  });

  it('treats blank values and non-string headers as unknown', () => {
    expect(buildRequestContext(TEST_PEPPER, fakeRequest('   ', '   ')).requesterHash).toBe(
      hashRequester(TEST_PEPPER, 'unknown', 'unknown'),
    );
    expect(
      buildRequestContext(TEST_PEPPER, fakeRequest('203.0.113.9', ['ua-array'])).requesterHash,
    ).toBe(hashRequester(TEST_PEPPER, '203.0.113.9', 'unknown'));
  });

  it('bounds externally supplied values before hashing', () => {
    const longIp = '1'.repeat(200);
    const longUserAgent = 'u'.repeat(1000);

    const context = buildRequestContext(TEST_PEPPER, fakeRequest(longIp, longUserAgent));

    expect(context.requesterHash).toBe(
      hashRequester(TEST_PEPPER, longIp.slice(0, 64), longUserAgent.slice(0, 256)),
    );
  });
});
