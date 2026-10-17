import { COLLECTIONS, docRef, type DocumentDatabase } from '../storage/types.js';
import { generateEventId } from '../otp/random.js';
import type { Logger } from '../logging.js';

export type AuditEventType =
  | 'otp.request.created'
  | 'otp.request.blocked'
  | 'otp.request.delivery_failed'
  | 'otp.verification.succeeded'
  | 'otp.verification.failed'
  | 'otp.challenge.locked'
  | 'otp.challenge.voided'
  | 'otp.challenge.expired';

export type AuditActorType = 'client' | 'system';

export interface AuditEvent {
  readonly eventId: string;
  readonly type: AuditEventType;
  readonly occurredAt: string;
  readonly actorType: AuditActorType;
  readonly actorHash: string | null;
  readonly purpose: string | null;
  readonly challengeId: string | null;
  readonly jobId: string | null;
  readonly phoneHash: string | null;
  readonly outcome: 'success' | 'failure';
  readonly reasonCode: string | null;
  readonly ttlAtMs: number;
}

export type NewAuditEvent = Omit<AuditEvent, 'eventId' | 'ttlAtMs'>;

export interface AuditSink {
  record(event: NewAuditEvent): Promise<void>;
}

/**
 * Best-effort audit sink: audit persistence must never break the OTP flow,
 * but failures are logged as warnings.
 */
export class SafeAuditSink implements AuditSink {
  private readonly inner: AuditSink;
  private readonly logger: Logger;

  constructor(inner: AuditSink, logger: Logger) {
    this.inner = inner;
    this.logger = logger;
  }

  async record(event: NewAuditEvent): Promise<void> {
    try {
      await this.inner.record(event);
    } catch {
      this.logger.warn('audit.write_failed', { eventType: event.type });
    }
  }
}

export class FirestoreAuditSink implements AuditSink {
  private readonly db: DocumentDatabase;
  private readonly retentionSeconds: number;
  private readonly clock: () => Date;

  constructor(
    db: DocumentDatabase,
    retentionSeconds: number,
    clock: () => Date = () => new Date(),
  ) {
    this.db = db;
    this.retentionSeconds = retentionSeconds;
    this.clock = clock;
  }

  async record(event: NewAuditEvent): Promise<void> {
    const occurredAtMs = this.clock().getTime();
    const full: AuditEvent = {
      ...event,
      eventId: generateEventId(),
      ttlAtMs: occurredAtMs + this.retentionSeconds * 1000,
    };
    await this.db.set(docRef(COLLECTIONS.auditEvents, full.eventId), full);
  }
}
