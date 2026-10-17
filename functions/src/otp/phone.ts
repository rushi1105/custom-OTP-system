const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
const INDIA_E164_PATTERN = /^\+91[6-9]\d{9}$/;
const INDIA_LOCAL_PATTERN = /^[6-9]\d{9}$/;
const INDIA_TRUNK_PATTERN = /^0[6-9]\d{9}$/;
const INDIA_COUNTRY_PATTERN = /^91[6-9]\d{9}$/;

/**
 * Upper bound applied before any normalization work. The longest realistic
 * input (E.164 with separators) is well under this; anything larger is rejected
 * to bound processing of externally supplied strings.
 */
export const MAX_PHONE_INPUT_LENGTH = 32;

/**
 * Normalizes a phone number to E.164.
 *
 * Phase 2 supports Indian numbers in common local formats plus any
 * format-valid E.164 number. Numbers are format-validated, not
 * carrier-validated; undeliverable destinations are the delivery
 * provider's responsibility to reject.
 *
 * Returns null when the input cannot be normalized safely.
 */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_PHONE_INPUT_LENGTH) {
    return null;
  }
  let value = raw.trim().replace(/[\s().-]/g, '');
  if (value.startsWith('00')) {
    value = `+${value.slice(2)}`;
  }
  if (value.startsWith('+91')) {
    return INDIA_E164_PATTERN.test(value) ? value : null;
  }
  if (INDIA_COUNTRY_PATTERN.test(value)) {
    return `+${value}`;
  }
  if (INDIA_TRUNK_PATTERN.test(value)) {
    return `+91${value.slice(1)}`;
  }
  if (INDIA_LOCAL_PATTERN.test(value)) {
    return `+91${value}`;
  }
  return E164_PATTERN.test(value) ? value : null;
}
