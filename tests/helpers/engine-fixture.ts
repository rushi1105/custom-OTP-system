import type { DeliveryProvider } from '@otp-infra/contracts';

import { ProviderDeliveryDispatcher } from '../../functions/src/delivery/dispatcher.js';
import {
  MockDeliveryProvider,
  type MockDeliveryProviderOptions,
} from '../../functions/src/delivery/mock-provider.js';
import { OtpEngine } from '../../functions/src/otp/engine.js';
import { DEFAULT_OTP_POLICY, type OtpPolicy } from '../../functions/src/otp/policy.js';
import { FixedClock } from './fixed-clock.js';
import { InMemoryDocumentDatabase } from './in-memory-database.js';
import { RecordingAuditSink } from './recording-audit-sink.js';
import { RecordingLogger } from './recording-logger.js';

export const TEST_PEPPER = 'test-pepper-0123456789abcdef0123456789abcdef';
export const TEST_PEPPER_VERSION = 1;
export const TEST_START_ISO = '2026-10-17T00:00:00.000Z';

export interface EngineFixture {
  readonly engine: OtpEngine;
  readonly db: InMemoryDocumentDatabase;
  readonly clock: FixedClock;
  readonly logger: RecordingLogger;
  readonly audit: RecordingAuditSink;
  readonly provider: DeliveryProvider;
  readonly policy: OtpPolicy;
  readonly pepper: string;
  readonly pepperVersion: number;
}

export function createEngineFixture(options?: {
  readonly policy?: Partial<OtpPolicy>;
  readonly provider?: DeliveryProvider;
  readonly providerOptions?: MockDeliveryProviderOptions;
  readonly startIso?: string;
  readonly pepper?: string;
  readonly pepperVersion?: number;
  readonly maxTransactionAttempts?: number;
}): EngineFixture {
  const clock = new FixedClock(options?.startIso ?? TEST_START_ISO);
  const db = new InMemoryDocumentDatabase(
    options?.maxTransactionAttempts !== undefined
      ? { maxTransactionAttempts: options.maxTransactionAttempts }
      : {},
  );
  const logger = new RecordingLogger();
  const audit = new RecordingAuditSink();
  const provider =
    options?.provider ??
    new MockDeliveryProvider({
      clock: () => clock.now(),
      ...(options?.providerOptions ?? {}),
    });
  const policy: OtpPolicy = { ...DEFAULT_OTP_POLICY, ...(options?.policy ?? {}) };
  const pepper = options?.pepper ?? TEST_PEPPER;
  const pepperVersion = options?.pepperVersion ?? TEST_PEPPER_VERSION;
  const dispatcher = new ProviderDeliveryDispatcher(provider, db, logger, () => clock.now());
  const engine = new OtpEngine({
    db,
    dispatcher,
    clock: () => clock.now(),
    logger,
    audit,
    policy,
    pepper,
    pepperVersion,
  });
  return { engine, db, clock, logger, audit, provider, policy, pepper, pepperVersion };
}

export function extractOtpCodeFromMessage(body: string): string {
  const match = /\b(\d{6})\b/.exec(body);
  const code = match?.[1];
  if (code === undefined) {
    throw new Error('no 6-digit code found in message body');
  }
  return code;
}
