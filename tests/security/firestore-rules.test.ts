import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';

import { COLLECTIONS } from '../../functions/src/storage/types';

const PROJECT_ID = process.env['GCLOUD_PROJECT'] ?? 'demo-otp-infrastructure-service';
const EMULATOR = process.env['FIRESTORE_EMULATOR_HOST'] ?? '';
const [EMULATOR_HOST, EMULATOR_PORT] = EMULATOR.split(':');

describe.skipIf(!process.env['FIRESTORE_EMULATOR_HOST'])(
  'firestore security rules deny all client access',
  () => {
    let testEnv: RulesTestEnvironment;

    beforeAll(async () => {
      testEnv = await initializeTestEnvironment({
        projectId: PROJECT_ID,
        firestore: {
          rules: readFileSync('firestore.rules', 'utf8'),
          host: EMULATOR_HOST,
          port: Number(EMULATOR_PORT ?? '8080'),
        },
      });
    });

    afterAll(async () => {
      await testEnv.cleanup();
    });

    it.each(Object.values(COLLECTIONS))(
      'denies unauthenticated read/write/delete/list on %s',
      async (collection) => {
        const firestore = testEnv.unauthenticatedContext().firestore();
        await assertFails(firestore.doc(`${collection}/probe`).get());
        await assertFails(firestore.doc(`${collection}/probe`).set({ hacked: true }));
        await assertFails(firestore.doc(`${collection}/probe`).delete());
        await assertFails(firestore.collection(collection).limit(1).get());
      },
    );

    it.each(Object.values(COLLECTIONS))(
      'denies authenticated read/write/delete/list on %s',
      async (collection) => {
        const firestore = testEnv.authenticatedContext('some-user-uid').firestore();
        await assertFails(firestore.doc(`${collection}/probe`).get());
        await assertFails(firestore.doc(`${collection}/probe`).set({ hacked: true }));
        await assertFails(firestore.doc(`${collection}/probe`).delete());
        await assertFails(firestore.collection(collection).limit(1).get());
      },
    );

    it('still allows the rules test environment admin context writes', async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const firestore = context.firestore();
        await assertSucceeds(
          firestore.doc(`${COLLECTIONS.auditEvents}/admin-probe`).set({ ok: true }),
        );
      });
      expect(testEnv).toBeDefined();
    });
  },
);
