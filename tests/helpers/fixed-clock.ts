export class FixedClock {
  private currentMs: number;

  constructor(iso: string) {
    this.currentMs = Date.parse(iso);
  }

  now = (): Date => new Date(this.currentMs);

  advanceSeconds(seconds: number): void {
    this.currentMs += seconds * 1000;
  }

  setIso(iso: string): void {
    this.currentMs = Date.parse(iso);
  }

  get currentTimeMs(): number {
    return this.currentMs;
  }
}
