import { getApps, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { onCall, onRequest } from 'firebase-functions/v2/https';

import { FirestoreAuditSink, SafeAuditSink } from './audit/audit-log.js';
import { buildRequestContext } from './api/context.js';
import { handleRequestOtp, handleVerifyOtp } from './api/handlers.js';
import { loadRuntimeConfig } from './config/env.js';
import { ProviderDeliveryDispatcher } from './delivery/dispatcher.js';
import { createDeliveryProvider } from './delivery/provider-factory.js';
import { healthHandler } from './health.js';
import { JsonConsoleLogger } from './logging.js';
import { OtpEngine } from './otp/engine.js';
import { FirestoreDocumentDatabase } from './storage/firestore-database.js';

const REGION = 'asia-south1';

interface Runtime {
  readonly engine: OtpEngine;
  readonly pepper: string;
}

let cachedRuntime: Runtime | null = null;

/**
 * Lazy composition root. Configuration is validated on first invocation so
 * the `health` endpoint and deployment checks never depend on OTP secrets.
 */
function getRuntime(): Runtime {
  if (cachedRuntime === null) {
    const clock = (): Date => new Date();
    const config = loadRuntimeConfig(process.env);
    const db = new FirestoreDocumentDatabase(getFirestore(getAdminApp()));
    const logger = new JsonConsoleLogger();
    const provider = createDeliveryProvider(process.env, clock);
    const dispatcher = new ProviderDeliveryDispatcher(provider, db, logger, clock);
    const audit = new SafeAuditSink(
      new FirestoreAuditSink(db, config.policy.auditRetentionSeconds, clock),
      logger,
    );
    const engine = new OtpEngine({
      db,
      dispatcher,
      clock,
      logger,
      audit,
      policy: config.policy,
      pepper: config.pepper,
      pepperVersion: config.pepperVersion,
    });
    cachedRuntime = { engine, pepper: config.pepper };
  }
  return cachedRuntime;
}

function getAdminApp(): App {
  const apps = getApps();
  if (apps.length > 0) {
    const existing = apps[0];
    if (existing !== undefined) {
      return existing;
    }
  }
  return initializeApp();
}

export const health = onRequest({ region: REGION }, healthHandler);

export const requestOtp = onCall({ region: REGION }, async (request) => {
  const runtime = getRuntime();
  return handleRequestOtp(
    runtime.engine,
    request.data,
    buildRequestContext(runtime.pepper, request),
  );
});

export const verifyOtp = onCall({ region: REGION }, async (request) => {
  const runtime = getRuntime();
  return handleVerifyOtp(
    runtime.engine,
    request.data,
    buildRequestContext(runtime.pepper, request),
  );
});
