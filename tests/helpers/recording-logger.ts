import type { LogFields, Logger } from '../../functions/src/logging.js';

export interface LogEntry {
  readonly level: 'info' | 'warn' | 'error';
  readonly event: string;
  readonly fields?: LogFields;
}

export class RecordingLogger implements Logger {
  readonly entries: LogEntry[] = [];

  info(event: string, fields?: LogFields): void {
    this.entries.push({ level: 'info', event, fields });
  }

  warn(event: string, fields?: LogFields): void {
    this.entries.push({ level: 'warn', event, fields });
  }

  error(event: string, fields?: LogFields): void {
    this.entries.push({ level: 'error', event, fields });
  }

  toJSON(): string {
    return JSON.stringify(this.entries);
  }
}
