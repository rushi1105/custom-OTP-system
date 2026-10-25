import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ProviderDeliveryDispatcher } from '../../functions/src/delivery/dispatcher';
import { MockDeliveryProvider } from '../../functions/src/delivery/mock-provider';
import { OtpEngine } from '../../functions/src/otp/engine';
import { DEFAULT_OTP_POLICY } from '../../functions/src/otp/policy';
import { FirestoreDocumentDatabase } from '../../functions/src/storage/firestore-database';
import { COLLECTIONS } from '../../functions/src/storage/types';
import { hashPhone } from '../../functions/src/otp/hashing';
import { FixedClock } from '../helpers/fixed-clock';
import { RecordingAuditSink } from '../helpers/recording-audit-sink';
import { RecordingLogger } from '../helpers/recording-logger';
import { extractOtpCodeFromMessage, TEST_PEPPER } from '../helpers/engine-fixture';

const PROJECT_ID = process.env['GCLOUD_PROJECT'] ?? 'demo-otp-infrastructure-service';
const PHONE = '+919876543210';
const REQUESTER = 'integration-requester-1';
const NINE_HUNDRED_SECONDS_MS = 900_000;
const START_MS =
  Math.floor(Date.parse('2026-10-17T00:00:00.000Z') / NINE_HUNDRED_SECONDS_MS) *
  NINE_HUNDRED_SECONDS_MS;
const START_ISO = new Date(START_MS).toISOString();

describe.skipIf(!process.env['FIRESTORE_EMULATOR_HOST'])(
  'OtpEngine against the Firestore emulator',
  () => {
    let app: App;
    let firestore: Firestore;
    let database: FirestoreDocumentDatabase;
    let engine: OtpEngine;
    let provider: MockDeliveryProvider;
    let clock: FixedClock;
    let logger: RecordingLogger;

    beforeAll(() => {
      app = initializeApp({ projectId: PROJECT_ID }, 'otp-integration-tests');
      firestore = getFirestore(app);
      database = new FirestoreDocumentDatabase(firestore);
    });

    afterAll(async () => {
      await deleteApp(app);
    });

    beforeEach(async () => {
      for (const collection of Object.values(COLLECTIONS)) {
        await firestore.recursiveDelete(firestore.collection(collection));
      }
      clock = new FixedClock(START_ISO);
      provider = new MockDeliveryProvider({ clock: () => clock.now() });
      logger = new RecordingLogger();
      engine = buildEngine(DEFAULT_OTP_POLICY);
    });

    function buildEngine(policy: typeof DEFAULT_OTP_POLICY): OtpEngine {
      return new OtpEngine({
        db: database,
        dispatcher: new ProviderDeliveryDispatcher(provider, database, logger, () => clock.now()),
        clock: () => clock.now(),
        logger,
        audit: new RecordingAuditSink(),
        policy,
        pepper: TEST_PEPPER,
        pepperVersion: 1,
      });
    }

    function uniquePhone(index: number): string {
      return `+9198765432${String(70 + index)}`;
    }

    async function createChallenge(phoneRaw: string = PHONE, requesterHash: string = REQUESTER) {
      const result = await engine.requestChallenge({
        phoneRaw,
        purpose: 'sign-in',
        requesterHash,
      });
      if (result.outcome !== 'created') {
        throw new Error(`expected challenge creation, got ${result.outcome}`);
      }
      const message = provider.recordedMessages.at(-1);
      if (message === undefined) {
        throw new Error('provider recorded no message');
      }
      return { challengeId: result.challengeId, code: extractOtpCodeFromMessage(message.body) };
    }

    it('runs the full request and verification flow', async () => {
      const { challengeId, code } = await createChallenge();

      const result = await engine.verifyChallenge({
        challengeId,
        code,
        purpose: 'sign-in',
        phoneRaw: PHONE,
        requesterHash: REQUESTER,
      });

      expect(result).toMatchObject({
        outcome: 'verified',
        purpose: 'sign-in',
        challengeId,
        e164: PHONE,
        phoneHash: hashPhone(TEST_PEPPER, PHONE),
      });
      const snapshot = await firestore.collection(COLLECTIONS.challenges).doc(challengeId).get();
      expect(snapshot.data()).toMatchObject({ status: 'consumed' });
      const jobDocs = await firestore.collection(COLLECTIONS.deliveryJobs).get();
      expect(jobDocs.size).toBe(1);
      expect(jobDocs.docs[0]?.data()).toMatchObject({ status: 'accepted' });
    });

    it('consumes exactly once under concurrent verification (Firestore transactions)', async () => {
      const { challengeId, code } = await createChallenge();

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          engine.verifyChallenge({
            challengeId,
            code,
            purpose: 'sign-in',
            phoneRaw: PHONE,
            requesterHash: REQUESTER,
          }),
        ),
      );

      expect(results.filter((result) => result.outcome === 'verified')).toHaveLength(1);
      expect(results.filter((result) => result.outcome === 'invalid')).toHaveLength(9);
    });

    it('creates only one challenge under concurrent duplicate requests for the same phone', async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          engine.requestChallenge({
            phoneRaw: PHONE,
            purpose: 'sign-in',
            requesterHash: REQUESTER,
          }),
        ),
      );

      expect(results.filter((result) => result.outcome === 'created')).toHaveLength(1);
      expect(
        results.filter(
          (result) => result.outcome === 'resend_cooldown' || result.outcome === 'rate_limited',
        ),
      ).toHaveLength(4);
      const challenges = await firestore.collection(COLLECTIONS.challenges).get();
      expect(challenges.size).toBe(1);
      expect(challenges.docs[0]?.data()).toMatchObject({ status: 'pending' });
    });

    it('rejects replay after consumption and after expiry against real Firestore', async () => {
      const first = await createChallenge();
      const verified = await engine.verifyChallenge({
        challengeId: first.challengeId,
        code: first.code,
        purpose: 'sign-in',
        phoneRaw: PHONE,
        requesterHash: REQUESTER,
      });
      expect(verified.outcome).toBe('verified');

      const replay = await engine.verifyChallenge({
        challengeId: first.challengeId,
        code: first.code,
        purpose: 'sign-in',
        phoneRaw: PHONE,
        requesterHash: REQUESTER,
      });
      expect(replay).toMatchObject({ outcome: 'invalid', internalReason: 'consumed' });

      clock.advanceSeconds(61);
      const second = await createChallenge();
      clock.advanceSeconds(301);
      const expired = await engine.verifyChallenge({
        challengeId: second.challengeId,
        code: second.code,
        purpose: 'sign-in',
        phoneRaw: PHONE,
        requesterHash: REQUESTER,
      });
      expect(expired).toMatchObject({ outcome: 'invalid', internalReason: 'expired' });

      const snapshot = await firestore
        .collection(COLLECTIONS.challenges)
        .doc(second.challengeId)
        .get();
      expect(snapshot.data()).toMatchObject({ status: 'expired' });
    });

    it('never persists plaintext phone numbers or OTP codes', async () => {
      const { challengeId, code } = await createChallenge();

      for (const collection of Object.values(COLLECTIONS)) {
        const docs = await firestore.collection(collection).get();
        const serialized = JSON.stringify(docs.docs.map((doc) => doc.data()));
        expect(serialized).not.toContain('9876543210');
        expect(serialized).not.toContain(code);
      }
      const challenge = await firestore.collection(COLLECTIONS.challenges).doc(challengeId).get();
      expect(challenge.exists).toBe(true);
      expect(challenge.data()).toHaveProperty('ttlAt');
    });

    it('resolves concurrent global-bucket contention to the configured cap', async () => {
      const racingEngine = buildEngine({ ...DEFAULT_OTP_POLICY, globalRequestsPerMinute: 3 });

      const results = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          racingEngine.requestChallenge({
            phoneRaw: uniquePhone(index),
            purpose: 'sign-in',
            requesterHash: `race-requester-${String(index)}`,
          }),
        ),
      );

      expect(results.filter((result) => result.outcome === 'created')).toHaveLength(3);
      const limited = results.filter((result) => result.outcome === 'rate_limited');
      expect(limited).toHaveLength(3);
      for (const result of limited) {
        if (result.outcome === 'rate_limited') {
          expect(result.scope).toBe('global');
        }
      }

      const challenges = await firestore.collection(COLLECTIONS.challenges).get();
      expect(challenges.size).toBe(3);
      const buckets = await firestore.collection(COLLECTIONS.rateLimits).get();
      expect(buckets.size).toBe(1);
      expect(buckets.docs[0]?.data()).toMatchObject({ count: 3 });
    });
  },
);
