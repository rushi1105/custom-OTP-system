import type { WindowLimit } from './policy.js';

export interface WindowEvaluation {
  readonly blocked: boolean;
  readonly windowStartMs: number;
  readonly count: number;
  readonly retryAfterSeconds: number;
}

export function windowStartMs(nowMs: number, windowSeconds: number): number {
  const windowMs = windowSeconds * 1000;
  return Math.floor(nowMs / windowMs) * windowMs;
}

/**
 * Fixed-window evaluation. Returns the counter value the caller should store
 * (`count`) and whether the current request must be blocked. A blocked request
 * never consumes quota.
 */
export function evaluateWindow(
  currentWindowStartMs: number | null,
  currentCount: number,
  nowMs: number,
  limit: WindowLimit,
): WindowEvaluation {
  const start = windowStartMs(nowMs, limit.windowSeconds);
  const inCurrentWindow = currentWindowStartMs === start;
  const count = inCurrentWindow ? currentCount : 0;
  if (count >= limit.max) {
    const windowEndMs = start + limit.windowSeconds * 1000;
    return {
      blocked: true,
      windowStartMs: start,
      count,
      retryAfterSeconds: Math.max(1, Math.ceil((windowEndMs - nowMs) / 1000)),
    };
  }
  return { blocked: false, windowStartMs: start, count: count + 1, retryAfterSeconds: 0 };
}
