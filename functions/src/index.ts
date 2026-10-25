import { getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { defineSecret } from 'firebase-functions/params';
import { onCall, onRequest } from 'firebase-functions/v2/https';

import { FirestoreAuditSink, SafeAuditSink } from './audit/audit-log.js';
import { buildRequestContext } from './api/context.js';
import { handleRequestOtp, handleVerifyOtp } from './api/handlers.js';
import { FirebaseAuthPort } from './auth/firebase-auth-port.js';
import { loadRuntimeConfig } from './config/env.js';
import { ProviderDeliveryDispatcher } from './delivery/dispatcher.js';
import { createDeliveryProvider } from './delivery/provider-factory.js';
import { healthHandler } from './health.js';
import { IdentityCreationService } from './identity/creation.js';
import { FirestoreIdentityStore } from './identity/firestore-identity-store.js';
import { IdentityResolver } from './identity/resolver.js';
import { JsonConsoleLogger } from './logging.js';
import { OtpEngine } from './otp/engine.js';
import { FirestoreDocumentDatabase } from './storage/firestore-database.js';

const REGION = 'asia-south1';

/**
 * D-020: the deployed pepper comes from Secret Manager. The local emulator may
 * use OTP_HASH_PEPPER from functions/.env.local; it is never committed.
 */
const otpHashPepperSecret = defineSecret('OTP_HASH_PEPPER');

interface Runtime {
  readonly engine: OtpEngine;
  readonly pepper: string;
  readonly identity: IdentityCreationService;
  readonly authPort: FirebaseAuthPort;
  readonly audit: SafeAuditSink;
  readonly logger: JsonConsoleLogger;
  readonly clock: () => Date;
}

let cachedRuntime: Runtime | null = null;

/**
 * Lazy composition root. Configuration is validated on first invocation so
 * the `health` endpoint and deployment checks never depend on OTP secrets.
 */
function getRuntime(pepperOverride?: string): Runtime {
  if (cachedRuntime === null) {
    const clock = (): Date => new Date();
    const config = loadRuntimeConfig(process.env, pepperOverride);
    const db = new FirestoreDocumentDatabase(getFirestore(getAdminApp()));
    const logger = new JsonConsoleLogger();
    const provider = createDeliveryProvider(config.deliveryProviderName, config.environment, clock);
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
    const authPort = new FirebaseAuthPort(getAuth(getAdminApp()));
    const identityStore = new FirestoreIdentityStore(db);
    const identity = new IdentityCreationService({
      resolver: new IdentityResolver({
        store: identityStore,
        auth: authPort,
        clock,
        logger,
        audit,
        pepper: config.pepper,
        pepperVersion: config.pepperVersion,
      }),
      store: identityStore,
      auth: authPort,
      clock,
      logger,
      audit,
      pepper: config.pepper,
      pepperVersion: config.pepperVersion,
    });
    cachedRuntime = {
      engine,
      pepper: config.pepper,
      identity,
      authPort,
      audit,
      logger,
      clock,
    };
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

/**
 * Resolve the pepper from the bound Secret Manager parameter. Local emulator
 * runs fall back to OTP_HASH_PEPPER (functions/.env.local) when the secret
 * parameter is not provisioned. Configuration validation still fails closed
 * when neither source is available.
 */
function resolvePepper(): string {
  try {
    const secretValue = otpHashPepperSecret.value();
    if (typeof secretValue === 'string' && secretValue.length > 0) {
      return secretValue;
    }
  } catch {
    // Emulator/local runs may not have the secret parameter provisioned.
  }
  // Plaintext env fallback is only for the local Functions emulator. A deployed
  // function missing its Secret Manager value must fail closed.
  if ((process.env['FUNCTIONS_EMULATOR'] ?? '').toLowerCase() === 'true') {
    return process.env['OTP_HASH_PEPPER'] ?? '';
  }
  return '';
}

export const health = onRequest({ region: REGION }, healthHandler);

export const requestOtp = onCall(
  { region: REGION, secrets: [otpHashPepperSecret] },
  async (request) => {
    const runtime = getRuntime(resolvePepper());
    return handleRequestOtp(
      runtime.engine,
      request.data,
      buildRequestContext(runtime.pepper, request),
    );
  },
);

export const verifyOtp = onCall(
  { region: REGION, secrets: [otpHashPepperSecret] },
  async (request) => {
    const runtime = getRuntime(resolvePepper());
    return handleVerifyOtp(
      {
        engine: runtime.engine,
        identity: runtime.identity,
        tokens: runtime.authPort,
        audit: runtime.audit,
        logger: runtime.logger,
        clock: runtime.clock,
      },
      request.data,
      buildRequestContext(runtime.pepper, request),
    );
  },
);
