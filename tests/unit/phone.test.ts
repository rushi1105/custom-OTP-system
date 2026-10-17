import { describe, expect, it } from 'vitest';

import { normalizePhone } from '../../functions/src/otp/phone';

describe('normalizePhone', () => {
  it.each([
    ['9876543210', '+919876543210'],
    ['+919876543210', '+919876543210'],
    ['919876543210', '+919876543210'],
    ['09876543210', '+919876543210'],
    ['00919876543210', '+919876543210'],
    ['98765 43210', '+919876543210'],
    ['98765-43210', '+919876543210'],
    ['(98765) 43210', '+919876543210'],
    ['+91 98765 43210', '+919876543210'],
    ['+14155552671', '+14155552671'],
    ['+442071838750', '+442071838750'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each([
    ['', 'empty string'],
    ['12345', 'too short'],
    ['5876543210', 'Indian mobile starting with 5'],
    ['+915876543210', 'Indian +91 with invalid leading digit'],
    ['+91987654321', 'too long for India'],
    ['+9198765432101', 'too long for India'],
    ['+0123456789', 'E.164 cannot start with 0'],
    ['phone', 'non-numeric'],
    ['++919876543210', 'double plus'],
    ['+91', 'country code only'],
  ])('rejects %s (%s)', (input) => {
    expect(normalizePhone(input)).toBeNull();
  });

  it('rejects non-string inputs', () => {
    expect(normalizePhone(919876543210)).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone({ toString: () => '+919876543210' })).toBeNull();
  });

  it('rejects oversized inputs before normalization work', () => {
    expect(normalizePhone('9'.repeat(10_000))).toBeNull();
    expect(normalizePhone(`+91${'9'.repeat(10_000)}`)).toBeNull();
    expect(normalizePhone('+9'.repeat(20))).toBeNull();
  });
});
