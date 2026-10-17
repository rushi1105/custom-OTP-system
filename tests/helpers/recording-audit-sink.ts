import type { AuditSink, NewAuditEvent } from '../../functions/src/audit/audit-log.js';

export class RecordingAuditSink implements AuditSink {
  readonly events: NewAuditEvent[] = [];

  async record(event: NewAuditEvent): Promise<void> {
    this.events.push(event);
  }

  toJSON(): string {
    return JSON.stringify(this.events);
  }
}
