#!/usr/bin/env node
/**
 * Operator-only helper for an isolated deployed test project: seed one valid
 * sign-in challenge so verifyOtp/custom-token/Auth behavior can be exercised
 * without SMS. This is NOT part of the public API and writes only a challenge
 * document through the Admin SDK.
 *
 * Safety guards:
 * - requires OTP_SEED_CONFIRM=isolated-test;
 * - refuses production/CoolBus/demo projects and any emulator host;
 * - requires an explicit test service-account credential;
 * - never prints the pepper or OTP code.
 */
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireFromFunctions = createRequire(resolve(root, 'functions', 'package.json'));

function fail(message) {
  console.error(`SEED REFUSED: ${message}`);
  process.exit(1);
}

const environment = (process.env['OTP_ENVIRONMENT'] ?? '').trim();
const projectId = (
  process.env['FIREBASE_PROJECT_ID'] ??
  process.env['GCLOUD_PROJECT'] ??
  ''
).trim();
const pepper = process.env['OTP_HASH_PEPPER'] ?? '';
const pepperVersionRaw = (process.env['OTP_HASH_PEPPER_VERSION'] ?? '').trim();
const phone = (process.env['OTP_TEST_PHONE'] ?? '').trim();
const code = (process.env['OTP_TEST_CODE'] ?? '').trim();
const credentials = (process.env['GOOGLE_APPLICATION_CREDENTIALS'] ?? '').trim();

if (process.env['OTP_SEED_CONFIRM'] !== 'isolated-test') {
  fail('set OTP_SEED_CONFIRM=isolated-test explicitly.');
}
if (environment !== 'test') {
  fail('OTP_ENVIRONMENT must be "test".');
}
if (projectId === '' || projectId.startsWith('demo-') || projectId === 'coolbus-1db23') {
  fail(
    'FIREBASE_PROJECT_ID must be a dedicated isolated test project (not demo-/CoolBus production).',
  );
}
if (
  process.env['FIRESTORE_EMULATOR_HOST'] ||
  process.env['FIREBASE_AUTH_EMULATOR_HOST'] ||
  process.env['FUNCTIONS_EMULATOR'] === 'true'
) {
  fail('emulator/emulator-host environment detected; use the emulator test harness instead.');
}
if (credentials === '') {
  fail('GOOGLE_APPLICATION_CREDENTIALS must point to an isolated test service account.');
}
if (typeof pepper !== 'string' || pepper.length < 32) {
  fail('OTP_HASH_PEPPER must be at least 32 characters.');
}
if (!/^[1-9]\d{0,8}$/.test(pepperVersionRaw)) {
  fail('OTP_HASH_PEPPER_VERSION must be a positive integer with no leading zeros.');
}
if (!/^\+91[6-9]\d{9}$/.test(phone)) {
  fail('OTP_TEST_PHONE must be a canonical Indian E.164 number (+91XXXXXXXXXX).');
}
if (!/^\d{6}$/.test(code)) {
  fail('OTP_TEST_CODE must be exactly six digits.');
}

const { initializeApp } = requireFromFunctions('firebase-admin/app');
const { getFirestore } = requireFromFunctions('firebase-admin/firestore');
const { hashCode, hashPhone, hashRequester } = requireFromFunctions('./dist/otp/hashing.js');

const challengeId = `c_${randomBytes(16).toString('base64url')}`;
const salt = randomBytes(16).toString('base64url');
const now = Date.now();
const phoneHash = hashPhone(pepper, phone);
const codeHash = hashCode(pepper, salt, 'sign-in', code);
const requesterHash = hashRequester(pepper, 'isolated-test-seed', challengeId);

const app = initializeApp({ projectId }, 'otp-isolated-test-seed');
const db = getFirestore(app);

try {
  await db
    .collection('otp_challenges')
    .doc(challengeId)
    .set({
      challengeId,
      purpose: 'sign-in',
      phoneHash,
      pepperVersion: Number(pepperVersionRaw),
      codeHash,
      salt,
      codeLength: 6,
      attempts: 0,
      maxAttempts: 5,
      status: 'pending',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 300_000).toISOString(),
      deliveryJobId: `j_${randomBytes(16).toString('base64url')}`,
      requesterHash,
      ttlAtMs: now + 86_400_000,
    });
} catch (error) {
  console.error('SEED FAILED: Firestore write failed; no secret or code was printed.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

console.log('SEED OK: one isolated test challenge created.');
console.log(`project: ${projectId}`);
console.log(`challengeId: ${challengeId}`);
console.log(`phone: ${phone.slice(0, 3)}******${phone.slice(-4)}`);
console.log('OTP code: supplied via OTP_TEST_CODE; value not printed.');
console.log('Use verifyOtp with the same phone and code; the challenge expires in 300s.');
