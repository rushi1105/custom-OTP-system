import { describe, expect, it } from 'vitest';

import {
  buildHealthPayload,
  healthHandler,
  SERVICE_NAME,
  SERVICE_VERSION,
} from '../../functions/src/health';

type HandlerResponse = Parameters<typeof healthHandler>[1];

function createResponseSpy(): {
  captured: { statusCode: number | undefined; body: unknown };
  res: HandlerResponse;
} {
  const captured: { statusCode: number | undefined; body: unknown } = {
    statusCode: undefined,
    body: undefined,
  };
  const json = (body: unknown): void => {
    captured.body = body;
  };
  const status = (code: number): { json: typeof json } => {
    captured.statusCode = code;
    return { json };
  };
  return { captured, res: { status } as unknown as HandlerResponse };
}

describe('health', () => {
  it('builds a payload containing only non-sensitive service metadata', () => {
    const payload = buildHealthPayload(() => new Date('2026-10-17T00:00:00.000Z'));

    expect(payload).toMatchObject({
      status: 'ok',
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      timestamp: '2026-10-17T00:00:00.000Z',
    });
  });

  it('defaults the environment to development when NODE_ENV is unset', () => {
    const original = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      expect(buildHealthPayload().environment).toBe('development');
    } finally {
      if (original === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = original;
      }
    }
  });

  it('responds with HTTP 200 and the health payload', () => {
    const { captured, res } = createResponseSpy();

    healthHandler({} as Parameters<typeof healthHandler>[0], res);

    expect(captured.statusCode).toBe(200);
    expect(captured.body).toMatchObject({
      status: 'ok',
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
    });
  });
});
