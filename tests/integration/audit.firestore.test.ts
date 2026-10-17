import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FirestoreAuditSink, SafeAuditSink } from '../../functions/src/audit/audit-log';
import { FirestoreDocumentDatabase } from '../../functions/src/storage/firestore-database';
import { COLLECTIONS } from '../../functions/src/storage/types';
import { RecordingLogger } from '../helpers/recording-logger';

const PROJECT_ID = process.env['GCLOUD_PROJECT'] ?? 'demo-otp-infrastructure-service';
const FIXED_NOW = new Date('2026-10-17T00:00:00.000Z');
const RETENTION_SECONDS = 7_776_000;

describe.skipIf(!process.env['FIRESTORE_EMULATOR_HOST'])(
  'FirestoreAuditSink against the Firestore emulator',
  () => {
    let app: App;
    let firestore: Firestore;

    beforeAll(() => {
      app = initializeApp({ projectId: PROJECT_ID }, 'audit-integration-tests');
      firestore = getFirestore(app);
    });

    afterAll(async () => {
      await deleteApp(app);
    });

    beforeEach(async () => {
      await firestore.recursiveDelete(firestore.collection(COLLECTIONS.auditEvents));
    });

    it('persists the documented shape with a ttlAt timestamp and no PII', async () => {
      const database = new FirestoreDocumentDatabase(firestore);
      const logger = new RecordingLogger();
      const sink = new SafeAuditSink(
        new FirestoreAuditSink(database, RETENTION_SECONDS, () => FIXED_NOW),
        logger,
      );

      await sink.record({
        type: 'otp.verification.failed',
        occurredAt: FIXED_NOW.toISOString(),
        actorType: 'client',
        actorHash: 'a'.repeat(64),
        purpose: 'sign-in',
        challengeId: 'c_AAAAAAAAAAAAAAAAAAAAAA',
        jobId: null,
        phoneHash: 'b'.repeat(64),
        outcome: 'failure',
        reasonCode: 'wrong_code',
      });

      expect(logger.entries).toHaveLength(0);
      const snapshot = await firestore.collection(COLLECTIONS.auditEvents).get();
      expect(snapshot.size).toBe(1);
      const document = snapshot.docs[0]?.data();
      expect(document).toBeDefined();
      expect(Object.keys(document ?? {}).sort()).toEqual(
        [
          'actorHash',
          'actorType',
          'challengeId',
          'eventId',
          'jobId',
          'occurredAt',
          'outcome',
          'phoneHash',
          'purpose',
          'reasonCode',
          'ttlAt',
          'ttlAtMs',
          'type',
        ].sort(),
      );
      expect(typeof document?.['ttlAt']?.toMillis).toBe('function');
      expect(document?.['ttlAtMs']).toBe(FIXED_NOW.getTime() + RETENTION_SECONDS * 1000);
      const serialized = JSON.stringify(document);
      expect(serialized).not.toContain('9876543210');
      expect(serialized).not.toContain('+91');
    });
  },
);
