import { describe, expect, it } from 'vitest';

import {
  generateChallengeId,
  generateEventId,
  generateJobId,
  generateOtpCode,
  generateSalt,
  isValidChallengeId,
  isValidOtpCode,
} from '../../functions/src/otp/random';

describe('otp randomness', () => {
  it('generates codes of the requested length using only digits', () => {
    for (const length of [4, 6, 8]) {
      const code = generateOtpCode(length);
      expect(code).toHaveLength(length);
      expect(code).toMatch(/^\d+$/);
    }
  });

  it('rejects unsafe code lengths', () => {
    expect(() => generateOtpCode(0)).toThrow();
    expect(() => generateOtpCode(3)).toThrow();
    expect(() => generateOtpCode(11)).toThrow();
    expect(() => generateOtpCode(6.5)).toThrow();
  });

  it('generates unique codes across a sample (no constant output)', () => {
    const sample = new Set(Array.from({ length: 200 }, () => generateOtpCode(6)));
    expect(sample.size).toBeGreaterThan(150);
  });

  it('generates challenge ids matching the expected format', () => {
    const ids = Array.from({ length: 500 }, () => generateChallengeId());
    for (const id of ids) {
      expect(id).toMatch(/^c_[A-Za-z0-9_-]{22}$/);
      expect(isValidChallengeId(id)).toBe(true);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('rejects malformed challenge ids', () => {
    expect(isValidChallengeId('c_short')).toBe(false);
    expect(isValidChallengeId('x_AAAAAAAAAAAAAAAAAAAAAA')).toBe(false);
    expect(isValidChallengeId('c_AAAAAAAAAAAAAAAAAAAAA!')).toBe(false);
    expect(isValidChallengeId(42)).toBe(false);
    expect(isValidChallengeId(null)).toBe(false);
  });

  it('generates unique salts and prefixed job/event ids', () => {
    expect(new Set(Array.from({ length: 500 }, () => generateSalt())).size).toBe(500);
    expect(generateJobId()).toMatch(/^j_[A-Za-z0-9_-]{22}$/);
    expect(generateEventId()).toMatch(/^a_[A-Za-z0-9_-]{16}$/);
  });

  it('validates otp codes exactly against the expected length and charset', () => {
    expect(isValidOtpCode('123456', 6)).toBe(true);
    expect(isValidOtpCode('12345', 6)).toBe(false);
    expect(isValidOtpCode('1234567', 6)).toBe(false);
    expect(isValidOtpCode('12345a', 6)).toBe(false);
    expect(isValidOtpCode(123456, 6)).toBe(false);
  });
});
