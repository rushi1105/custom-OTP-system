export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export class JsonConsoleLogger implements Logger {
  info(event: string, fields?: LogFields): void {
    this.write('info', event, fields);
  }

  warn(event: string, fields?: LogFields): void {
    this.write('warn', event, fields);
  }

  error(event: string, fields?: LogFields): void {
    this.write('error', event, fields);
  }

  private write(level: 'info' | 'warn' | 'error', event: string, fields?: LogFields): void {
    const line = JSON.stringify({ level, event, ...fields });
    if (level === 'info') {
      console.log(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.error(line);
    }
  }
}
