import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Phase 3.3a â€” empirical validation of Firebase Auth emulator behavior that the
 * approved identity-creation design depends on. This is deliberately a
 * test-only harness: no production Auth adapter, creation service, claims, or
 * token code is introduced.
 *
 * The integration script starts the Auth emulator (`--only firestore,auth`) and
 * exports FIREBASE_AUTH_EMULATOR_HOST. These tests must genuinely execute in
 * `npm run test:integration`; they only skip in the emulator-less unit run.
 */

const AUTH_EMULATOR_HOST = process.env['FIREBASE_AUTH_EMULATOR_HOST'];
const PROJECT_ID = process.env['GCLOUD_PROJECT'] ?? 'demo-otp-infrastructure-service';

/**
 * Observed against the Auth emulator on 2026-10-19: duplicate phones surface as
 * `auth/phone-number-already-exists` (not the commonly referenced
 * `auth/phone-already-exists`). The identity adapter (Phase 3.3b) must map this
 * observed code; the plan's assumed literal is corrected in the Phase 3.3a
 * report.
 */
const DUPLICATE_PHONE_ERROR_CODE = 'auth/phone-number-already-exists';

async function captureErrorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe.skipIf(!AUTH_EMULATOR_HOST)('Firebase Auth emulator assumptions (Phase 3.3a)', () => {
  let app: App;
  let auth: Auth;

  beforeAll(() => {
    app = initializeApp({ projectId: PROJECT_ID }, 'auth-emulator-assumption-tests');
    auth = getAuth(app);
  });

  afterAll(async () => {
    await deleteApp(app);
  });

  it('is connected to the Auth emulator (env marker present)', () => {
    expect(AUTH_EMULATOR_HOST).toBeTruthy();
    expect(AUTH_EMULATOR_HOST).toContain(':');
  });

  it('returns user-not-found for an unknown phone', async () => {
    const code = await captureErrorCode(auth.getUserByPhoneNumber('+919876540001'));
    expect(code).toBe('auth/user-not-found');
  });

  it('creates a user with an E.164 phone and finds the same UID by phone', async () => {
    const phone = '+919876540002';
    const created = await auth.createUser({ phoneNumber: phone });

    expect(created.uid).toBeTruthy();
    expect(created.phoneNumber).toBe(phone);

    const byUid = await auth.getUser(created.uid);
    expect(byUid.phoneNumber).toBe(phone);

    const byPhone = await auth.getUserByPhoneNumber(phone);
    expect(byPhone.uid).toBe(created.uid);
  });

  it('rejects a duplicate phone with the exact observed error code', async () => {
    const phone = '+919876540003';
    await auth.createUser({ phoneNumber: phone });

    const code = await captureErrorCode(auth.createUser({ phoneNumber: phone }));
    expect(code).toBe(DUPLICATE_PHONE_ERROR_CODE);
  });

  it('serializes concurrent duplicate creates into exactly one success', async () => {
    const phone = '+919876540004';
    const results = await Promise.allSettled([
      auth.createUser({ phoneNumber: phone }),
      auth.createUser({ phoneNumber: phone }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0]?.reason as { code?: string }).code).toBe(DUPLICATE_PHONE_ERROR_CODE);

    const users = await auth.getUserByPhoneNumber(phone);
    expect(users.uid).toBe((fulfilled[0] as PromiseFulfilledResult<{ uid: string }>).value.uid);
  });

  it('rejects updating a second user onto an already-claimed phone', async () => {
    const phone = '+919876540005';
    await auth.createUser({ phoneNumber: phone });
    const second = await auth.createUser({ email: 'phase33a.second@example.test' });

    const code = await captureErrorCode(auth.updateUser(second.uid, { phoneNumber: phone }));
    expect(code).toBe(DUPLICATE_PHONE_ERROR_CODE);
  });

  it('records whether disabled users are returned by phone lookup', async () => {
    const phone = '+919876540006';
    const user = await auth.createUser({ phoneNumber: phone });
    await auth.updateUser(user.uid, { disabled: true });

    const outcome = await auth.getUserByPhoneNumber(phone).then(
      (found) => ({ found: true as const, uid: found.uid, disabled: found.disabled }),
      (error: { code?: string }) => ({ found: false as const, code: error.code }),
    );

    expect(outcome).toEqual({ found: true, uid: user.uid, disabled: true });
  });

  it('records whether deleted users are returned by phone lookup', async () => {
    const phone = '+919876540007';
    const user = await auth.createUser({ phoneNumber: phone });
    await auth.deleteUser(user.uid);

    const outcome = await auth.getUserByPhoneNumber(phone).then(
      (found) => ({ found: true as const, uid: found.uid }),
      (error: { code?: string }) => ({ found: false as const, code: error.code }),
    );

    expect(outcome).toEqual({ found: false, code: 'auth/user-not-found' });
  });

  it('rejects an invalid phone with a reliable error code', async () => {
    const code = await captureErrorCode(auth.createUser({ phoneNumber: 'not-a-phone' }));
    expect(code).toBe('auth/invalid-phone-number');
  });
});
