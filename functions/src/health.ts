import type { Request, Response } from 'express';

import { describeOtpEnvironment } from './config/env.js';

export const SERVICE_NAME = 'otp-infrastructure-service';
export const SERVICE_VERSION = '0.2.1';

export interface HealthPayload {
  readonly status: 'ok';
  readonly service: string;
  readonly version: string;
  readonly environment: string;
  readonly timestamp: string;
}

export function buildHealthPayload(
  clock: () => Date = () => new Date(),
  env: NodeJS.ProcessEnv = process.env,
): HealthPayload {
  return {
    status: 'ok',
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    environment: describeOtpEnvironment(env),
    timestamp: clock().toISOString(),
  };
}

export function healthHandler(_req: Request, res: Response): void {
  res.status(200).json(buildHealthPayload());
}
