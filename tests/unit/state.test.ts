import { describe, expect, it } from 'vitest';

import { evaluateWindow, windowStartMs } from '../../functions/src/otp/state';

const FIFTEEN_MINUTES = { max: 3, windowSeconds: 900 };

describe('windowStartMs', () => {
  it('floors timestamps to the window boundary', () => {
    const start = 1_800_000_000_000; // already a multiple of 900_000
    expect(windowStartMs(start, 900)).toBe(start);
    expect(windowStartMs(start + 183_000, 900)).toBe(start);
    expect(windowStartMs(start + 900_000, 900)).toBe(start + 900_000);
  });
});

describe('evaluateWindow', () => {
  const start = 1_800_000_000_000;

  it('opens a fresh window with count 1 when no prior state exists', () => {
    expect(evaluateWindow(null, 0, start + 5_000, FIFTEEN_MINUTES)).toEqual({
      blocked: false,
      windowStartMs: start,
      count: 1,
      retryAfterSeconds: 0,
    });
  });

  it('allows requests up to the limit and reports the next count', () => {
    expect(evaluateWindow(start, 2, start + 10_000, FIFTEEN_MINUTES)).toEqual({
      blocked: false,
      windowStartMs: start,
      count: 3,
      retryAfterSeconds: 0,
    });
  });

  it('blocks at the limit without incrementing and returns the exact retry-after', () => {
    const now = start + 183_000;
    expect(evaluateWindow(start, 3, now, FIFTEEN_MINUTES)).toEqual({
      blocked: true,
      windowStartMs: start,
      count: 3,
      retryAfterSeconds: 717,
    });
  });

  it('rounds retry-after up to at least one second near the window end', () => {
    const now = start + 899_750;
    expect(evaluateWindow(start, 3, now, FIFTEEN_MINUTES)).toEqual({
      blocked: true,
      windowStartMs: start,
      count: 3,
      retryAfterSeconds: 1,
    });
  });

  it('resets counts at the exact window boundary', () => {
    const now = start + 900_000;
    expect(evaluateWindow(start, 3, now, FIFTEEN_MINUTES)).toEqual({
      blocked: false,
      windowStartMs: now,
      count: 1,
      retryAfterSeconds: 0,
    });
  });

  it('resets counts when the stored window is stale', () => {
    expect(evaluateWindow(start - 900_000, 3, start + 1_000, FIFTEEN_MINUTES)).toEqual({
      blocked: false,
      windowStartMs: start,
      count: 1,
      retryAfterSeconds: 0,
    });
  });
});
