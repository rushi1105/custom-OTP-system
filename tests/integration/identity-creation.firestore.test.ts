import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FirestoreAuditSink, type AuditEvent } from '../../functions/src/audit/audit-log';
import { FirebaseAuthPort } from '../../functions/src/auth/firebase-auth-port';
import { IdentityCreationService } from '../../functions/src/identity/creation';
import {
  AuthPhoneAlreadyExistsError,
  AuthUnavailableError,
} from '../../functions/src/identity/errors';
import { FirestoreIdentityStore } from '../../functions/src/identity/firestore-identity-store';
import type { IdentityStore } from '../../functions/src/identity/identity-store';
import { IdentityResolver } from '../../functions/src/identity/resolver';
import type {
  AcquireCreationClaimInput,
  AuthPort,
  AuthUserRecord,
  ClaimAcquisitionResult,
  ClaimFinalizationResult,
  ClaimReleaseResult,
  FinalizeCreationClaimInput,
  IdentityLinkFillResult,
  IdentityLinkRecord,
  ReleaseCreationClaimInput,
} from '../../functions/src/identity/types';
import { hashPhone } from '../../functions/src/otp/hashing';
import { FirestoreDocumentDatabase } from '../../functions/src/storage/firestore-database';
import { COLLECTIONS } from '../../functions/src/storage/types';
import { TEST_PEPPER, TEST_PEPPER_VERSION, TEST_START_ISO } from '../helpers/engine-fixture';
import { FixedClock } from '../helpers/fixed-clock';
import { buildIdentityLink } from '../helpers/identity-fakes';
import { RecordingLogger } from '../helpers/recording-logger';

const PROJECT_ID = process.env['GCLOUD_PROJECT'] ?? 'demo-otp-infrastructure-service';
const AUDIT_RETENTION_SECONDS = 7_776_000;
const REQUESTER_HASH = 'r'.repeat(64);

type FillActiveLinkInput = Parameters<IdentityStore['fillActiveLink']>[0];

interface Deferred {
  readonly promise: Promise<void>;
  resolve: () => void;
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/** Releases all parties only after every party has arrived. */
class Barrier {
  private arrivals = 0;
  private readonly released = createDeferred();

  constructor(private readonly parties: number) {}

  async arrive(): Promise<void> {
    this.arrivals += 1;
    if (this.arrivals >= this.parties) {
      this.released.resolve();
    }
    await this.released.promise;
  }
}

/**
 * Delegating IdentityStore used only to observe calls and inject a finalization
 * failure. All real claim state remains in Firestore.
 */
class TrackingIdentityStore implements IdentityStore {
  readonly acquireCalls: AcquireCreationClaimInput[] = [];
  readonly acquireResults: ClaimAcquisitionResult[] = [];
  readonly finalizeCalls: FinalizeCreationClaimInput[] = [];
  readonly releaseCalls: ReleaseCreationClaimInput[] = [];
  failNextFinalize = false;
  firstGetLinkBarrier: Barrier | null = null;
  onFinalize: ((result: ClaimFinalizationResult) => void) | null = null;

  constructor(private readonly inner: IdentityStore) {}

  async getLink(phoneHash: string): Promise<IdentityLinkRecord | null> {
    const result = await this.inner.getLink(phoneHash);
    const barrier = this.firstGetLinkBarrier;
    if (barrier !== null) {
      this.firstGetLinkBarrier = null;
      await barrier.arrive();
    }
    return result;
  }

  async fillActiveLink(input: FillActiveLinkInput): Promise<IdentityLinkFillResult> {
    return this.inner.fillActiveLink(input);
  }

  async acquireCreationClaim(input: AcquireCreationClaimInput): Promise<ClaimAcquisitionResult> {
    this.acquireCalls.push(input);
    const result = await this.inner.acquireCreationClaim(input);
    this.acquireResults.push(result);
    return result;
  }

  async finalizeCreationClaim(input: FinalizeCreationClaimInput): Promise<ClaimFinalizationResult> {
    this.finalizeCalls.push(input);
    if (this.failNextFinalize) {
      this.failNextFinalize = false;
      throw new Error('injected Firestore finalization failure');
    }
    const result = await this.inner.finalizeCreationClaim(input);
    this.onFinalize?.(result);
    return result;
  }

  async releaseCreationClaim(input: ReleaseCreationClaimInput): Promise<ClaimReleaseResult> {
    this.releaseCalls.push(input);
    return this.inner.releaseCreationClaim(input);
  }
}

/**
 * Delegating Auth port. It never stores identity state itself; lookups and
 * creates delegate to the real FirebaseAuthPort/Auth emulator. Injection points:
 * - the second lookup (post-claim) can gate or fail;
 * - creation can create a real competing user and then report the duplicate
 *   error observed from the Auth emulator.
 */
class ControlledAuthPort implements AuthPort {
  lookupCalls = 0;
  failLookupCall: number | null = null;
  competeOnCreate = false;
  postClaimGate: Deferred | null = null;
  onPostClaimLookup: (() => void) | null = null;
  readonly createCalls: string[] = [];

  constructor(private readonly inner: AuthPort) {}

  async getUser(uid: string): Promise<AuthUserRecord | null> {
    return this.inner.getUser(uid);
  }

  async getUserByPhoneNumber(e164: string): Promise<AuthUserRecord | null> {
    this.lookupCalls += 1;
    const call = this.lookupCalls;
    if (call === 2) {
      this.onPostClaimLookup?.();
      if (this.postClaimGate !== null) {
        await this.postClaimGate.promise;
      }
    }
    if (this.failLookupCall === call) {
      throw new AuthUnavailableError('injected Auth outage', 'auth/internal-error');
    }
    return this.inner.getUserByPhoneNumber(e164);
  }

  async createUserWithPhone(e164: string): Promise<AuthUserRecord> {
    this.createCalls.push(e164);
    if (this.competeOnCreate) {
      await this.inner.createUserWithPhone(e164);
      throw new AuthPhoneAlreadyExistsError(
        'phone already registered',
        'auth/phone-number-already-exists',
      );
    }
    return this.inner.createUserWithPhone(e164);
  }
}

describe.skipIf(
  !process.env['FIRESTORE_EMULATOR_HOST'] || !process.env['FIREBASE_AUTH_EMULATOR_HOST'],
)('IdentityCreationService against Firestore and Auth emulators', () => {
  let app: App;
  let firestore: Firestore;
  let auth: Auth;
  let database: FirestoreDocumentDatabase;
  let store: FirestoreIdentityStore;
  let baseAuth: FirebaseAuthPort;
  let clock: FixedClock;
  let logger: RecordingLogger;
  let audit: FirestoreAuditSink;
  const createdPhones = new Set<string>();

  beforeAll(() => {
    app = initializeApp({ projectId: PROJECT_ID }, 'identity-creation-integration-tests');
    firestore = getFirestore(app);
    auth = getAuth(app);
    database = new FirestoreDocumentDatabase(firestore);
    store = new FirestoreIdentityStore(database);
    baseAuth = new FirebaseAuthPort(auth);
  });

  afterAll(async () => {
    await deleteApp(app);
  });

  beforeEach(async () => {
    await firestore.recursiveDelete(firestore.collection(COLLECTIONS.identityLinks));
    await firestore.recursiveDelete(firestore.collection(COLLECTIONS.auditEvents));
    createdPhones.clear();
    clock = new FixedClock(TEST_START_ISO);
    logger = new RecordingLogger();
    audit = new FirestoreAuditSink(database, AUDIT_RETENTION_SECONDS, () => clock.now());
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

  function buildService(
    options: {
      readonly store?: IdentityStore;
      readonly auth?: AuthPort;
      readonly sleep?: () => Promise<void>;
    } = {},
  ): IdentityCreationService {
    const serviceStore = options.store ?? store;
    const serviceAuth = options.auth ?? baseAuth;
    const resolver = new IdentityResolver({
      store: serviceStore,
      auth: serviceAuth,
      clock: () => clock.now(),
      logger,
      audit,
      pepper: TEST_PEPPER,
      pepperVersion: TEST_PEPPER_VERSION,
    });
    return new IdentityCreationService({
      resolver,
      store: serviceStore,
      auth: serviceAuth,
      clock: () => clock.now(),
      logger,
      audit,
      pepper: TEST_PEPPER,
      pepperVersion: TEST_PEPPER_VERSION,
      sleep: options.sleep ?? (async () => undefined),
    });
  }

  function ensure(service: IdentityCreationService, phone: string, challengeId: string) {
    createdPhones.add(phone);
    return service.ensureIdentity({
      e164: phone,
      challengeId,
      purpose: 'sign-in',
      requesterHash: REQUESTER_HASH,
    });
  }

  async function readLink(phoneHash: string): Promise<IdentityLinkRecord | undefined> {
    const snapshot = await firestore.collection(COLLECTIONS.identityLinks).doc(phoneHash).get();
    return snapshot.exists ? (snapshot.data() as IdentityLinkRecord) : undefined;
  }

  async function readAuditEvents(): Promise<AuditEvent[]> {
    const snapshot = await firestore.collection(COLLECTIONS.auditEvents).get();
    return snapshot.docs.map((doc) => doc.data() as AuditEvent);
  }

  function uniquePhone(suffix: number): string {
    return `+919876551${String(suffix).padStart(3, '0')}`;
  }

  it('creates one Auth identity and finalizes one active link under concurrent first-time calls', async () => {
    const phone = uniquePhone(1);
    const phoneHash = hashPhone(TEST_PEPPER, phone);
    const barrier = new Barrier(2);
    const storeA = new TrackingIdentityStore(store);
    storeA.firstGetLinkBarrier = barrier;
    const storeB = new TrackingIdentityStore(store);
    storeB.firstGetLinkBarrier = barrier;
    const authA = new ControlledAuthPort(baseAuth);
    const authB = new ControlledAuthPort(baseAuth);
    const serviceA = buildService({ store: storeA, auth: authA });
    const serviceB = buildService({ store: storeB, auth: authB });

    const results = await Promise.all([
      ensure(serviceA, phone, 'c_integration_0001'),
      ensure(serviceB, phone, 'c_integration_0002'),
    ]);

    const created = results.filter((result) => result.status === 'created');
    expect(created).toHaveLength(1);
    const winner = created[0];
    if (winner?.status !== 'created') {
      throw new Error('expected exactly one created result');
    }
    for (const result of results) {
      if ('uid' in result) {
        expect(result.uid).toBe(winner.uid);
      } else {
        expect(result).toEqual({ status: 'unavailable', reason: 'claim_pending' });
      }
    }

    expect(authA.createCalls.length + authB.createCalls.length).toBe(1);
    const link = await readLink(phoneHash);
    expect(link).toMatchObject({
      status: 'active',
      uid: winner.uid,
      claimId: null,
      claimExpiresAtMs: null,
    });
    await expect(baseAuth.getUserByPhoneNumber(phone)).resolves.toEqual({
      uid: winner.uid,
      phoneNumber: phone,
      disabled: false,
    });

    await expect(
      store.finalizeCreationClaim({
        phoneHash,
        claimId: 'claim-stale',
        uid: 'uid-stale',
        challengeId: 'c_stale',
        pepperVersion: TEST_PEPPER_VERSION,
        nowMs: clock.currentTimeMs,
      }),
    ).resolves.toEqual({ outcome: 'blocked', reason: 'conflict_uid_mismatch' });
    await expect(
      store.releaseCreationClaim({ phoneHash, claimId: 'claim-stale' }),
    ).resolves.toEqual({ outcome: 'not_owner' });
    expect(await readLink(phoneHash)).toMatchObject({ status: 'active', uid: winner.uid });

    const createdEvents = (await readAuditEvents()).filter(
      (event) => event.type === 'identity.created',
    );
    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0]).toMatchObject({
      uid: winner.uid,
      phoneHash,
      outcome: 'success',
      reasonCode: null,
    });
  });

  it('does not let a competing service overwrite an in-progress winner claim', async () => {
    const phone = uniquePhone(2);
    const phoneHash = hashPhone(TEST_PEPPER, phone);
    const barrier = new Barrier(2);
    const winnerGate = createDeferred();
    const winnerReached = createDeferred();
    const storeA = new TrackingIdentityStore(store);
    storeA.firstGetLinkBarrier = barrier;
    const storeB = new TrackingIdentityStore(store);
    storeB.firstGetLinkBarrier = barrier;
    const authA = new ControlledAuthPort(baseAuth);
    authA.postClaimGate = winnerGate;
    authA.onPostClaimLookup = () => winnerReached.resolve();
    const authB = new ControlledAuthPort(baseAuth);
    authB.postClaimGate = winnerGate;
    authB.onPostClaimLookup = () => winnerReached.resolve();
    const serviceA = buildService({ store: storeA, auth: authA });
    const serviceB = buildService({ store: storeB, auth: authB });

    const promiseA = ensure(serviceA, phone, 'c_integration_0011');
    const promiseB = ensure(serviceB, phone, 'c_integration_0012');
    await winnerReached.promise;

    const loser = await Promise.race([
      promiseA.then((result) => ({ service: 'A' as const, result })),
      promiseB.then((result) => ({ service: 'B' as const, result })),
    ]);
    try {
      expect(loser.result).toEqual({ status: 'unavailable', reason: 'claim_pending' });

      const linkBefore = await readLink(phoneHash);
      expect(linkBefore?.status).toBe('pending_creation');
      expect(linkBefore?.uid).toBeNull();
      expect(typeof linkBefore?.claimId).toBe('string');

      const winnerStore = loser.service === 'A' ? storeB : storeA;
      const loserStore = loser.service === 'A' ? storeA : storeB;
      expect(winnerStore.acquireCalls).toHaveLength(1);
      expect(loserStore.acquireCalls).toHaveLength(1);
      expect(winnerStore.acquireResults).toEqual([{ outcome: 'acquired' }]);
      expect(loserStore.acquireResults).toEqual([{ outcome: 'in_progress' }]);
      expect(loserStore.finalizeCalls).toHaveLength(0);
      expect(linkBefore?.claimId).toBe(winnerStore.acquireCalls[0]?.claimId);
      expect(
        (await readAuditEvents()).filter((event) => event.type === 'identity.created'),
      ).toHaveLength(0);
    } finally {
      winnerGate.resolve();
    }

    const winnerResult = await (loser.service === 'A' ? promiseB : promiseA);
    expect(winnerResult.status).toBe('created');
    if (winnerResult.status !== 'created') {
      throw new Error('expected the gated service to create');
    }

    const linkAfter = await readLink(phoneHash);
    expect(linkAfter).toMatchObject({ status: 'active', uid: winnerResult.uid, claimId: null });
    expect(authA.createCalls.length + authB.createCalls.length).toBe(1);
    await expect(baseAuth.getUserByPhoneNumber(phone)).resolves.toEqual({
      uid: winnerResult.uid,
      phoneNumber: phone,
      disabled: false,
    });
    const createdEvents = (await readAuditEvents()).filter(
      (event) => event.type === 'identity.created',
    );
    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0]).toMatchObject({ uid: winnerResult.uid, phoneHash });
  });

  it('takes over an expired claim and prevents the prior owner from finalizing or releasing it', async () => {
    const phone = uniquePhone(3);
    const phoneHash = hashPhone(TEST_PEPPER, phone);
    const gate = createDeferred();
    const reached = createDeferred();
    const controlledAuth = new ControlledAuthPort(baseAuth);
    controlledAuth.postClaimGate = gate;
    controlledAuth.onPostClaimLookup = () => reached.resolve();
    const service = buildService({ auth: controlledAuth });

    await firestore
      .collection(COLLECTIONS.identityLinks)
      .doc(phoneHash)
      .set(
        buildIdentityLink({
          phoneHash,
          status: 'pending_creation',
          uid: null,
          claimId: 'claim-old',
          claimedAtMs: clock.currentTimeMs - 240_000,
          claimExpiresAtMs: clock.currentTimeMs - 120_000,
        }),
      );

    const promise = ensure(service, phone, 'c_integration_0021');
    await reached.promise;

    const takeover = await readLink(phoneHash);
    expect(takeover).toMatchObject({ status: 'pending_creation', uid: null });
    const newClaimId = takeover?.claimId;
    if (typeof newClaimId !== 'string') {
      throw new Error('expected a new claim id');
    }
    expect(newClaimId).not.toBe('claim-old');

    try {
      await expect(
        store.finalizeCreationClaim({
          phoneHash,
          claimId: 'claim-old',
          uid: 'uid-old',
          challengeId: 'c_old',
          pepperVersion: TEST_PEPPER_VERSION,
          nowMs: clock.currentTimeMs,
        }),
      ).resolves.toEqual({ outcome: 'claim_lost' });
      await expect(
        store.releaseCreationClaim({ phoneHash, claimId: 'claim-old' }),
      ).resolves.toEqual({ outcome: 'not_owner' });
      expect(await readLink(phoneHash)).toMatchObject({
        status: 'pending_creation',
        claimId: newClaimId,
      });
    } finally {
      gate.resolve();
    }

    const result = await promise;
    expect(result.status).toBe('created');
    if (result.status !== 'created') {
      throw new Error('expected expired-claim takeover to create an identity');
    }

    const finalLink = await readLink(phoneHash);
    expect(finalLink).toMatchObject({ status: 'active', uid: result.uid, claimId: null });
    await expect(baseAuth.getUserByPhoneNumber(phone)).resolves.toEqual({
      uid: result.uid,
      phoneNumber: phone,
      disabled: false,
    });

    const events = await readAuditEvents();
    expect(events.filter((event) => event.type === 'identity.claim.expired')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'identity.created')).toHaveLength(1);

    await expect(
      store.finalizeCreationClaim({
        phoneHash,
        claimId: 'claim-old',
        uid: 'uid-old',
        challengeId: 'c_old',
        pepperVersion: TEST_PEPPER_VERSION,
        nowMs: clock.currentTimeMs,
      }),
    ).resolves.toEqual({ outcome: 'blocked', reason: 'conflict_uid_mismatch' });
    await expect(store.releaseCreationClaim({ phoneHash, claimId: 'claim-old' })).resolves.toEqual({
      outcome: 'not_owner',
    });
  });

  it('recovers from a duplicate Auth creation by linking the authoritative existing user', async () => {
    const phone = uniquePhone(4);
    const phoneHash = hashPhone(TEST_PEPPER, phone);
    const controlledAuth = new ControlledAuthPort(baseAuth);
    controlledAuth.competeOnCreate = true;
    const service = buildService({ auth: controlledAuth });

    const result = await ensure(service, phone, 'c_integration_0031');

    expect(result.status).toBe('recovered');
    if (result.status !== 'recovered') {
      throw new Error('expected duplicate-phone recovery');
    }

    await expect(baseAuth.getUserByPhoneNumber(phone)).resolves.toEqual({
      uid: result.uid,
      phoneNumber: phone,
      disabled: false,
    });
    const links = await firestore.collection(COLLECTIONS.identityLinks).get();
    expect(links.size).toBe(1);
    expect(await readLink(phoneHash)).toMatchObject({
      status: 'active',
      uid: result.uid,
      claimId: null,
    });
    expect(controlledAuth.createCalls).toHaveLength(1);

    const events = await readAuditEvents();
    expect(events.filter((event) => event.type === 'identity.created')).toHaveLength(0);
    const resolvedEvents = events.filter((event) => event.type === 'identity.resolved');
    expect(resolvedEvents).toHaveLength(1);
    expect(resolvedEvents[0]).toMatchObject({ uid: result.uid, phoneHash, outcome: 'success' });
  });

  it('preserves the created Auth identity when Firestore finalization fails after creation', async () => {
    const phone = uniquePhone(5);
    const phoneHash = hashPhone(TEST_PEPPER, phone);
    const trackingStore = new TrackingIdentityStore(store);
    trackingStore.failNextFinalize = true;
    const controlledAuth = new ControlledAuthPort(baseAuth);
    const service = buildService({ store: trackingStore, auth: controlledAuth });

    const result = await ensure(service, phone, 'c_integration_0041');

    expect(result).toEqual({ status: 'unavailable', reason: 'store_unavailable' });
    const user = await baseAuth.getUserByPhoneNumber(phone);
    expect(user?.phoneNumber).toBe(phone);
    expect(await readLink(phoneHash)).toBeUndefined();
    expect(controlledAuth.createCalls).toHaveLength(1);
    expect(trackingStore.finalizeCalls).toHaveLength(1);
    expect(trackingStore.releaseCalls).toHaveLength(1);
    expect(trackingStore.releaseCalls[0]?.claimId).toBe(trackingStore.acquireCalls[0]?.claimId);

    const events = await readAuditEvents();
    const createdEvents = events.filter((event) => event.type === 'identity.created');
    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0]).toMatchObject({ uid: user?.uid, outcome: 'success' });
  });

  it('releases only its own claim and fails closed when Auth is unavailable after claim acquisition', async () => {
    const phone = uniquePhone(6);
    const phoneHash = hashPhone(TEST_PEPPER, phone);
    const trackingStore = new TrackingIdentityStore(store);
    const controlledAuth = new ControlledAuthPort(baseAuth);
    controlledAuth.failLookupCall = 2;
    const service = buildService({ store: trackingStore, auth: controlledAuth });

    const result = await ensure(service, phone, 'c_integration_0051');

    expect(result).toEqual({ status: 'unavailable', reason: 'auth_unavailable' });
    await expect(baseAuth.getUserByPhoneNumber(phone)).resolves.toBeNull();
    expect(await readLink(phoneHash)).toBeUndefined();
    expect(trackingStore.acquireCalls).toHaveLength(1);
    expect(trackingStore.releaseCalls).toHaveLength(1);
    expect(trackingStore.releaseCalls[0]?.claimId).toBe(trackingStore.acquireCalls[0]?.claimId);
    expect(trackingStore.finalizeCalls).toHaveLength(0);
    expect(controlledAuth.createCalls).toHaveLength(0);
  });

  it('recovers a losing concurrent attempt to the winning authoritative identity', async () => {
    const phone = uniquePhone(7);
    const phoneHash = hashPhone(TEST_PEPPER, phone);
    const barrier = new Barrier(2);
    const winnerFinalized = createDeferred();
    const storeA = new TrackingIdentityStore(store);
    storeA.firstGetLinkBarrier = barrier;
    storeA.onFinalize = (result) => {
      if (result.outcome === 'finalized') {
        winnerFinalized.resolve();
      }
    };
    const storeB = new TrackingIdentityStore(store);
    storeB.firstGetLinkBarrier = barrier;
    storeB.onFinalize = (result) => {
      if (result.outcome === 'finalized') {
        winnerFinalized.resolve();
      }
    };
    const authA = new ControlledAuthPort(baseAuth);
    const authB = new ControlledAuthPort(baseAuth);
    const waitForWinner = () => winnerFinalized.promise;
    const serviceA = buildService({ store: storeA, auth: authA, sleep: waitForWinner });
    const serviceB = buildService({ store: storeB, auth: authB, sleep: waitForWinner });

    const results = await Promise.all([
      ensure(serviceA, phone, 'c_integration_0061'),
      ensure(serviceB, phone, 'c_integration_0062'),
    ]);

    const created = results.filter((result) => result.status === 'created');
    const resolved = results.filter((result) => result.status === 'resolved');
    expect(created).toHaveLength(1);
    expect(resolved).toHaveLength(1);
    const winner = created[0];
    if (winner?.status !== 'created') {
      throw new Error('expected one created result');
    }
    const loser = resolved[0];
    if (loser?.status !== 'resolved') {
      throw new Error('expected one resolved loser');
    }
    expect(loser.uid).toBe(winner.uid);
    expect(authA.createCalls.length + authB.createCalls.length).toBe(1);

    const link = await readLink(phoneHash);
    expect(link).toMatchObject({ status: 'active', uid: winner.uid, claimId: null });
    await expect(baseAuth.getUserByPhoneNumber(phone)).resolves.toEqual({
      uid: winner.uid,
      phoneNumber: phone,
      disabled: false,
    });

    const events = await readAuditEvents();
    expect(events.filter((event) => event.type === 'identity.created')).toHaveLength(1);
    const resolvedEvents = events.filter((event) => event.type === 'identity.resolved');
    expect(resolvedEvents).toHaveLength(1);
    expect(resolvedEvents[0]).toMatchObject({
      uid: winner.uid,
      phoneHash,
      outcome: 'success',
      reasonCode: null,
    });
  });
});
