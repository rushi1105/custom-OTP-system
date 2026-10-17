import { describe, expect, it } from 'vitest';

import {
  hashCode,
  hashPhone,
  hashRequester,
  safeEqualHex,
  verifyCodeHash,
} from '../../functions/src/otp/hashing';

const PEPPER_A = 'pepper-a-0123456789abcdef0123456789abcdef';
const PEPPER_B = 'pepper-b-0123456789abcdef0123456789abcdef';

describe('keyed hashing', () => {
  it('produces deterministic hex HMACs namespaced by purpose', () => {
    const phone = '+919876543210';
    expect(hashPhone(PEPPER_A, phone)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPhone(PEPPER_A, phone)).toBe(hashPhone(PEPPER_A, phone));
    expect(hashPhone(PEPPER_A, phone)).not.toBe(hashPhone(PEPPER_B, phone));
    expect(hashPhone(PEPPER_A, phone)).not.toBe(hashRequester(PEPPER_A, phone, 'ua'));
  });

  it('binds the code hash to salt, purpose and code', () => {
    const base = hashCode(PEPPER_A, 'salt-1', 'sign-in', '123456');
    expect(base).toBe(hashCode(PEPPER_A, 'salt-1', 'sign-in', '123456'));
    expect(base).not.toBe(hashCode(PEPPER_A, 'salt-2', 'sign-in', '123456'));
    expect(base).not.toBe(hashCode(PEPPER_A, 'salt-1', 'phone-verification', '123456'));
    expect(base).not.toBe(hashCode(PEPPER_A, 'salt-1', 'sign-in', '123457'));
    expect(base).not.toBe(hashCode(PEPPER_B, 'salt-1', 'sign-in', '123456'));
  });

  it('verifies only the correct code and is not fooled by length or encoding tricks', () => {
    const expected = hashCode(PEPPER_A, 'salt-1', 'sign-in', '123456');
    expect(verifyCodeHash(PEPPER_A, 'salt-1', 'sign-in', '123456', expected)).toBe(true);
    expect(verifyCodeHash(PEPPER_A, 'salt-1', 'sign-in', '123457', expected)).toBe(false);
    expect(verifyCodeHash(PEPPER_B, 'salt-1', 'sign-in', '123456', expected)).toBe(false);
    expect(safeEqualHex(expected, 'ab')).toBe(false);
    expect(safeEqualHex('', '')).toBe(false);
    expect(safeEqualHex('zz', 'zz')).toBe(false);
  });
});
