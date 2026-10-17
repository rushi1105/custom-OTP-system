import { describe, expect, it } from 'vitest';

import {
  FirestoreAuditSink,
  SafeAuditSink,
  type AuditEvent,
  type NewAuditEvent,
} from '../../functions/src/audit/audit-log';
import {
  COLLECTIONS,
  type DocumentDatabase,
  type DocumentRef,
} from '../../functions/src/storage/types';
import { InMemoryDocumentDatabase } from '../helpers/in-memory-database';
import { RecordingLogger } from '../helpers/recording-logger';

const FIXED_NOW = new Date('2026-10-17T00:00:00.000Z');
const RETENTION_SECONDS = 7_776_000;
const PHONE_DIGITS = '9876543210';

const EVENT: NewAuditEvent = {
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
};

function failingDatabase(): DocumentDatabase {
  return {
    runTransaction: async () => {
      throw new Error('audit database unavailable');
    },
    set: async <T>(_ref: DocumentRef, _data: T): Promise<void> => {
      throw new Error('audit database unavailable');
    },
  };
}

describe('SafeAuditSink', () => {
  it('swallows backend failures, logs a warning, and never breaks the caller', async () => {
    const logger = new RecordingLogger();
    const sink = new SafeAuditSink(
      new FirestoreAuditSink(failingDatabase(), RETENTION_SECONDS),
      logger,
    );

    await expect(sink.record(EVENT)).resolves.toBeUndefined();

    expect(logger.entries).toContainEqual({
      level: 'warn',
      event: 'audit.write_failed',
      fields: { eventType: 'otp.verification.failed' },
    });
  });

  it('passes events through without warning when the backend succeeds', async () => {
    const logger = new RecordingLogger();
    const db = new InMemoryDocumentDatabase();
    const sink = new SafeAuditSink(
      new FirestoreAuditSink(db, RETENTION_SECONDS, () => FIXED_NOW),
      logger,
    );

    await sink.record(EVENT);

    expect(logger.entries).toHaveLength(0);
    expect(db.listDocuments(COLLECTIONS.auditEvents)).toHaveLength(1);
  });

  it('the underlying FirestoreAuditSink propagates failures when used directly', async () => {
    const sink = new FirestoreAuditSink(failingDatabase(), RETENTION_SECONDS, () => FIXED_NOW);

    await expect(sink.record(EVENT)).rejects.toThrow('audit database unavailable');
  });
});

describe('FirestoreAuditSink', () => {
  it('persists the documented event shape with a retention timestamp', async () => {
    const db = new InMemoryDocumentDatabase();
    const sink = new FirestoreAuditSink(db, RETENTION_SECONDS, () => FIXED_NOW);

    await sink.record(EVENT);

    const documents = db.listDocuments<AuditEvent>(COLLECTIONS.auditEvents);
    expect(documents).toHaveLength(1);
    const stored = documents[0];
    expect(stored).toBeDefined();
    expect(Object.keys(stored ?? {}).sort()).toEqual(
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
        'ttlAtMs',
        'type',
      ].sort(),
    );
    expect(stored?.eventId).toMatch(/^a_[A-Za-z0-9_-]{16}$/);
    expect(stored?.ttlAtMs).toBe(FIXED_NOW.getTime() + RETENTION_SECONDS * 1000);
    expect(stored?.phoneHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never persists phone numbers, codes, or tokens in audit events', async () => {
    const db = new InMemoryDocumentDatabase();
    const sink = new FirestoreAuditSink(db, RETENTION_SECONDS, () => FIXED_NOW);

    await sink.record(EVENT);

    const serialized = db.dump();
    expect(serialized).not.toContain(PHONE_DIGITS);
    expect(serialized).not.toContain('+91');
    expect(serialized).not.toContain('customToken');
    expect(serialized).not.toContain('123456');
  });
});
