import { generateKeyPairSync } from 'node:crypto';
import {
  deleteApp as deleteClientApp,
  initializeApp as initializeClientApp,
  type FirebaseApp,
} from 'firebase/app';
import {
  connectAuthEmulator,
  getAuth as getClientAuth,
  onAuthStateChanged,
  signInWithCustomToken,
  signOut,
  type Auth as ClientAuth,
} from 'firebase/auth';
import { cert, deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  FirestoreAuditSink,
  SafeAuditSink,
  type AuditEvent,
} from '../../functions/src/audit/audit-log';
import { handleRequestOtp, handleVerifyOtp } from '../../functions/src/api/handlers';
import type { CustomTokenIssuer } from '../../functions/src/auth/token-issuer';
import { FirebaseAuthPort } from '../../functions/src/auth/firebase-auth-port';
import { ProviderDeliveryDispatcher } from '../../functions/src/delivery/dispatcher';
import { MockDeliveryProvider } from '../../functions/src/delivery/mock-provider';
import { IdentityCreationService } from '../../functions/src/identity/creation';
import { AuthUnavailableError } from '../../functions/src/identity/errors';
import { FirestoreIdentityStore } from '../../functions/src/identity/firestore-identity-store';
import { IdentityResolver } from '../../functions/src/identity/resolver';
import { hashPhone } from '../../functions/src/otp/hashing';
import { OtpEngine } from '../../functions/src/otp/engine';
import { DEFAULT_OTP_POLICY } from '../../functions/src/otp/policy';
import type { ChallengeRecord } from '../../functions/src/otp/types';
import { FirestoreDocumentDatabase } from '../../functions/src/storage/firestore-database';
import { COLLECTIONS } from '../../functions/src/storage/types';
import { TEST_PEPPER, TEST_PEPPER_VERSION, TEST_START_ISO } from '../helpers/engine-fixture';
import { extractOtpCodeFromMessage } from '../helpers/engine-fixture';
import { FixedClock } from '../helpers/fixed-clock';
import { buildIdentityLink } from '../helpers/identity-fakes';
import { RecordingLogger } from '../helpers/recording-logger';

const PROJECT_ID = process.env['GCLOUD_PROJECT'] ?? 'demo-otp-infrastructure-service';
const AUDIT_RETENTION_SECONDS = 7_776_000;
const REQUESTER_HASH = 'verify-otp-integration-requester';

class ControlledTokenIssuer implements CustomTokenIssuer {
  readonly calls: string[] = [];
  fail = false;

  constructor(private readonly inner: CustomTokenIssuer) {}

  async createCustomToken(uid: string): Promise<string> {
    this.calls.push(uid);
    if (this.fail) {
      throw new AuthUnavailableError('injected token failure', 'auth/internal-error');
    }
    return this.inner.createCustomToken(uid);
  }
}

async function captureHttpsError(promise: Promise<unknown>): Promise<HttpsError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpsError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the promise to reject with an HttpsError');
}

describe.skipIf(
  !process.env['FIRESTORE_EMULATOR_HOST'] || !process.env['FIREBASE_AUTH_EMULATOR_HOST'],
)(
  'verifyOtp → identity → custom token → client session against Firestore and Auth emulators',
  () => {
    let app: App;
    let firestore: Firestore;
    let auth: Auth;
    let database: FirestoreDocumentDatabase;
    let authPort: FirebaseAuthPort;
    let clock: FixedClock;
    let logger: RecordingLogger;
    let provider: MockDeliveryProvider;
    let engine: OtpEngine;
    let identity: IdentityCreationService;
    let tokens: ControlledTokenIssuer;
    let verifyDeps: Parameters<typeof handleVerifyOtp>[0];
    const createdPhones = new Set<string>();
    let clientAppSequence = 0;

    beforeAll(() => {
      const projectId = PROJECT_ID;
      const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      });
      app = initializeApp(
        {
          projectId,
          // Test-only signing credential; never a production secret. The Auth
          // emulator handles user state; this only lets the Admin SDK sign tokens
          // locally instead of attempting metadata-server credential discovery.
          credential: cert({
            projectId,
            clientEmail: `test@${projectId}.iam.gserviceaccount.com`,
            privateKey,
          }),
        },
        'verify-otp-integration-tests',
      );
      firestore = getFirestore(app);
      auth = getAuth(app);
      database = new FirestoreDocumentDatabase(firestore);
      authPort = new FirebaseAuthPort(auth);
    });

    afterAll(async () => {
      await deleteApp(app);
    });

    beforeEach(async () => {
      for (const collection of Object.values(COLLECTIONS)) {
        await firestore.recursiveDelete(firestore.collection(collection));
      }
      createdPhones.clear();
      clock = new FixedClock(TEST_START_ISO);
      logger = new RecordingLogger();
      const audit = new SafeAuditSink(
        new FirestoreAuditSink(database, AUDIT_RETENTION_SECONDS, () => clock.now()),
        logger,
      );
      provider = new MockDeliveryProvider({ clock: () => clock.now() });
      engine = new OtpEngine({
        db: database,
        dispatcher: new ProviderDeliveryDispatcher(provider, database, logger, () => clock.now()),
        clock: () => clock.now(),
        logger,
        audit,
        policy: DEFAULT_OTP_POLICY,
        pepper: TEST_PEPPER,
        pepperVersion: TEST_PEPPER_VERSION,
      });
      const store = new FirestoreIdentityStore(database);
      identity = new IdentityCreationService({
        resolver: new IdentityResolver({
          store,
          auth: authPort,
          clock: () => clock.now(),
          logger,
          audit,
          pepper: TEST_PEPPER,
          pepperVersion: TEST_PEPPER_VERSION,
        }),
        store,
        auth: authPort,
        clock: () => clock.now(),
        logger,
        audit,
        pepper: TEST_PEPPER,
        pepperVersion: TEST_PEPPER_VERSION,
        sleep: async () => undefined,
      });
      tokens = new ControlledTokenIssuer(authPort);
      verifyDeps = {
        engine,
        identity,
        tokens,
        audit,
        logger,
        clock: () => clock.now(),
      };
    });

    afterEach(async () => {
      for (const phone of createdPhones) {
        try {
          const user = await auth.getUserByPhoneNumber(phone);
          await auth.deleteUser(user.uid);
        } catch (error) {
          const code =
            typeof error === 'object' && error !== null
              ? (error as { code?: unknown }).code
              : undefined;
          if (code !== 'auth/user-not-found') {
            throw error;
          }
        }
      }
      createdPhones.clear();
    });

    function uniquePhone(suffix: number): string {
      return `+919876552${String(suffix).padStart(3, '0')}`;
    }

    function authEmulatorUrl(): string {
      const host = process.env['FIREBASE_AUTH_EMULATOR_HOST'] ?? '127.0.0.1:9099';
      return host.startsWith('http') ? host : `http://${host}`;
    }

    async function createClientAuth(emulatorUrl = authEmulatorUrl()) {
      clientAppSequence += 1;
      const app: FirebaseApp = initializeClientApp(
        {
          apiKey: 'demo-api-key',
          projectId: PROJECT_ID,
          authDomain: `${PROJECT_ID}.firebaseapp.com`,
        },
        `verify-otp-client-${String(clientAppSequence)}`,
      );
      const clientAuth = getClientAuth(app);
      connectAuthEmulator(clientAuth, emulatorUrl, { disableWarnings: true });
      return {
        auth: clientAuth,
        dispose: async () => {
          if (clientAuth.currentUser !== null) {
            await signOut(clientAuth);
          }
          await deleteClientApp(app);
        },
      };
    }

    function waitForAuthenticatedUid(clientAuth: ClientAuth): Promise<string> {
      return new Promise((resolve) => {
        const unsubscribe = onAuthStateChanged(clientAuth, (user) => {
          if (user !== null) {
            unsubscribe();
            resolve(user.uid);
          }
        });
      });
    }

    async function captureClientAuthError(promise: Promise<unknown>): Promise<{ code?: string }> {
      try {
        await promise;
        return {};
      } catch (error) {
        return error as { code?: string };
      }
    }

    async function requestChallenge(phone: string) {
      const response = await handleRequestOtp(
        engine,
        { phone, purpose: 'sign-in' },
        { requesterHash: REQUESTER_HASH },
      );
      const message = provider.recordedMessages.at(-1);
      if (message === undefined) {
        throw new Error('mock provider recorded no message');
      }
      return {
        challengeId: response.challengeId,
        code: extractOtpCodeFromMessage(message.body),
      };
    }

    async function verify(
      phone: string,
      challengeId: string,
      code: string,
      extra: Record<string, unknown> = {},
    ) {
      return handleVerifyOtp(
        verifyDeps,
        { ...extra, challengeId, code, purpose: 'sign-in', phone },
        { requesterHash: REQUESTER_HASH },
      );
    }

    async function readLink(phoneHash: string) {
      const snapshot = await firestore.collection(COLLECTIONS.identityLinks).doc(phoneHash).get();
      return snapshot.exists ? snapshot.data() : undefined;
    }

    async function readChallenge(challengeId: string) {
      const snapshot = await firestore.collection(COLLECTIONS.challenges).doc(challengeId).get();
      return snapshot.exists ? (snapshot.data() as ChallengeRecord) : undefined;
    }

    async function readAuditEvents(): Promise<AuditEvent[]> {
      const snapshot = await firestore.collection(COLLECTIONS.auditEvents).get();
      return snapshot.docs.map((doc) => doc.data() as AuditEvent);
    }

    it('completes request → verify → identity creation → custom-token issuance', async () => {
      const phone = uniquePhone(1);
      createdPhones.add(phone);
      const { challengeId, code } = await requestChallenge(phone);

      const response = await verify(phone, challengeId, code, {
        uid: 'uid_attacker',
        role: 'admin',
      });

      expect(response).toEqual({
        verified: true,
        purpose: 'sign-in',
        customToken: expect.any(String),
      });
      expect(response.customToken.split('.')).toHaveLength(3);
      const user = await authPort.getUserByPhoneNumber(phone);
      if (user === null) {
        throw new Error('expected the identity flow to create an Auth user');
      }
      expect(tokens.calls).toEqual([user.uid]);

      const client = await createClientAuth();
      try {
        const authenticatedUid = waitForAuthenticatedUid(client.auth);
        const credential = await signInWithCustomToken(client.auth, response.customToken);
        expect(credential.user.uid).toBe(user.uid);
        expect(client.auth.currentUser?.uid).toBe(user.uid);
        await expect(authenticatedUid).resolves.toBe(user.uid);
        const idToken = await credential.user.getIdToken();
        expect(idToken.split('.')).toHaveLength(3);
      } finally {
        await client.dispose();
      }

      const phoneHash = hashPhone(TEST_PEPPER, phone);
      expect(await readLink(phoneHash)).toMatchObject({
        status: 'active',
        uid: user?.uid,
        claimId: null,
      });
      expect(await readChallenge(challengeId)).toMatchObject({ status: 'consumed' });

      const events = await readAuditEvents();
      expect(events.some((event) => event.type === 'otp.verification.succeeded')).toBe(true);
      expect(events.some((event) => event.type === 'identity.created')).toBe(true);
      expect(events.find((event) => event.type === 'token.issued')).toMatchObject({
        uid: user?.uid,
        outcome: 'success',
        reasonCode: null,
      });

      const serialized = logger.toJSON() + JSON.stringify(events);
      expect(serialized).not.toContain('9876552');
      expect(serialized).not.toContain(response.customToken);
    });

    it('rejects a phone mismatch without consuming, incrementing attempts, or minting', async () => {
      const phone = uniquePhone(2);
      const otherPhone = uniquePhone(99);
      createdPhones.add(phone);
      const { challengeId, code } = await requestChallenge(phone);

      const error = await captureHttpsError(verify(otherPhone, challengeId, code));

      expect(error.code).toBe('permission-denied');
      expect(error.details).toEqual({ code: 'CODE_INVALID' });
      expect(await readChallenge(challengeId)).toMatchObject({ status: 'pending', attempts: 0 });
      expect(await authPort.getUserByPhoneNumber(phone)).toBeNull();
      expect(await readLink(hashPhone(TEST_PEPPER, phone))).toBeUndefined();
      expect(tokens.calls).toHaveLength(0);

      const verified = await verify(phone, challengeId, code);
      expect(verified.verified).toBe(true);
      expect(tokens.calls).toHaveLength(1);
    });

    it('resolves an existing authoritative user and mints a token for that UID', async () => {
      const phone = uniquePhone(3);
      createdPhones.add(phone);
      const existing = await auth.createUser({ phoneNumber: phone });
      const { challengeId, code } = await requestChallenge(phone);

      const response = await verify(phone, challengeId, code);

      expect(tokens.calls).toEqual([existing.uid]);
      expect(response.customToken).toEqual(expect.any(String));
      expect(await readLink(hashPhone(TEST_PEPPER, phone))).toMatchObject({
        status: 'active',
        uid: existing.uid,
      });
      expect(await authPort.getUserByPhoneNumber(phone)).toMatchObject({ uid: existing.uid });

      const events = await readAuditEvents();
      expect(events.some((event) => event.type === 'identity.resolved')).toBe(true);
      expect(events.some((event) => event.type === 'identity.created')).toBe(false);
    });

    it('rejects an expired challenge without touching identity or tokens', async () => {
      const phone = uniquePhone(4);
      createdPhones.add(phone);
      const { challengeId, code } = await requestChallenge(phone);
      clock.advanceSeconds(301);

      const error = await captureHttpsError(verify(phone, challengeId, code));

      expect(error.code).toBe('permission-denied');
      expect(error.details).toEqual({ code: 'CODE_INVALID' });
      expect(await readChallenge(challengeId)).toMatchObject({ status: 'expired' });
      expect(await authPort.getUserByPhoneNumber(phone)).toBeNull();
      expect(tokens.calls).toHaveLength(0);
    });

    it('fails closed after consumption on identity conflict and requires a fresh OTP', async () => {
      const phone = uniquePhone(5);
      createdPhones.add(phone);
      const phoneHash = hashPhone(TEST_PEPPER, phone);
      await firestore
        .collection(COLLECTIONS.identityLinks)
        .doc(phoneHash)
        .set(buildIdentityLink({ phoneHash, status: 'revoked', uid: 'uid_revoked' }));
      const { challengeId, code } = await requestChallenge(phone);

      const error = await captureHttpsError(verify(phone, challengeId, code));

      expect(error.code).toBe('unavailable');
      expect(error.details).toEqual({ code: 'IDENTITY_UNAVAILABLE' });
      expect(error.message).toBe('Unable to complete sign-in right now');
      expect(await readChallenge(challengeId)).toMatchObject({ status: 'consumed' });
      expect(await authPort.getUserByPhoneNumber(phone)).toBeNull();
      expect(tokens.calls).toHaveLength(0);
      expect(await readLink(phoneHash)).toMatchObject({ status: 'revoked', uid: 'uid_revoked' });
      expect(logger.toJSON()).not.toContain('conflict_link_revoked');

      const replay = await captureHttpsError(verify(phone, challengeId, code));
      expect(replay.details).toEqual({ code: 'CODE_INVALID' });
      const events = await readAuditEvents();
      expect(events.some((event) => event.type === 'token.issued')).toBe(false);
      expect(events.some((event) => event.type === 'token.issue_failed')).toBe(false);
    });

    it('fails closed after identity success when custom-token minting fails', async () => {
      const phone = uniquePhone(6);
      createdPhones.add(phone);
      tokens.fail = true;
      const { challengeId, code } = await requestChallenge(phone);

      const error = await captureHttpsError(verify(phone, challengeId, code));

      expect(error.code).toBe('unavailable');
      expect(error.details).toEqual({ code: 'IDENTITY_UNAVAILABLE' });
      expect(error.message).toBe('Unable to complete sign-in right now');
      expect(tokens.calls).toHaveLength(1);
      const user = await authPort.getUserByPhoneNumber(phone);
      expect(user).not.toBeNull();
      expect(await readLink(hashPhone(TEST_PEPPER, phone))).toMatchObject({
        status: 'active',
        uid: user?.uid,
      });
      expect(await readChallenge(challengeId)).toMatchObject({ status: 'consumed' });

      const events = await readAuditEvents();
      expect(events.find((event) => event.type === 'token.issue_failed')).toMatchObject({
        uid: user?.uid,
        outcome: 'failure',
        reasonCode: 'auth_unavailable',
      });
      expect(events.some((event) => event.type === 'token.issued')).toBe(false);
      const serialized = logger.toJSON() + JSON.stringify(events);
      expect(serialized).not.toContain('9876552');
      expect(serialized).not.toContain('fake-custom-token');

      const replay = await captureHttpsError(verify(phone, challengeId, code));
      expect(replay.details).toEqual({ code: 'CODE_INVALID' });
    });

    // The Auth emulator explicitly does not validate JWT signatures or expiry.
    // Expired-token rejection therefore remains a production (Phase 3.7) check.
    it('rejects malformed custom tokens without creating a client session', async () => {
      const client = await createClientAuth();
      try {
        const error = await captureClientAuthError(
          signInWithCustomToken(client.auth, 'not-a-custom-token'),
        );
        expect(error.code).toBe('auth/invalid-custom-token');
        expect(client.auth.currentUser).toBeNull();
      } finally {
        await client.dispose();
      }
    });

    it('surfaces network exchange failure without a session and succeeds on retry', async () => {
      const phone = uniquePhone(7);
      createdPhones.add(phone);
      const user = await auth.createUser({ phoneNumber: phone });
      const customToken = await auth.createCustomToken(user.uid);

      const failedClient = await createClientAuth('http://127.0.0.1:1');
      try {
        const error = await captureClientAuthError(
          signInWithCustomToken(failedClient.auth, customToken),
        );
        expect(error.code).toBe('auth/network-request-failed');
        expect(failedClient.auth.currentUser).toBeNull();
      } finally {
        await failedClient.dispose();
      }

      const retryClient = await createClientAuth();
      try {
        const credential = await signInWithCustomToken(retryClient.auth, customToken);
        expect(credential.user.uid).toBe(user.uid);
        expect(retryClient.auth.currentUser?.uid).toBe(user.uid);
      } finally {
        await retryClient.dispose();
      }
    });
  },
);
