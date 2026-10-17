import { createHmac, timingSafeEqual } from 'node:crypto';

import type { OtpPurpose } from './policy.js';

function hmacHex(pepper: string, message: string): string {
  return createHmac('sha256', pepper).update(message).digest('hex');
}

export function hashPhone(pepper: string, e164Phone: string): string {
  return hmacHex(pepper, `phone:v1:${e164Phone}`);
}

export function hashCode(pepper: string, salt: string, purpose: OtpPurpose, code: string): string {
  return hmacHex(pepper, `code:v1:${salt}:${purpose}:${code}`);
}

export function hashRequester(pepper: string, ip: string, userAgent: string): string {
  return hmacHex(pepper, `requester:v1:${ip}:${userAgent}`);
}

export function safeEqualHex(leftHex: string, rightHex: string): boolean {
  const left = Buffer.from(leftHex, 'hex');
  const right = Buffer.from(rightHex, 'hex');
  if (left.length === 0 || left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

export function verifyCodeHash(
  pepper: string,
  salt: string,
  purpose: OtpPurpose,
  submittedCode: string,
  expectedHash: string,
): boolean {
  return safeEqualHex(hashCode(pepper, salt, purpose, submittedCode), expectedHash);
}
