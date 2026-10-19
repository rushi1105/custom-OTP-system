import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FirestoreIdentityStore } from '../../functions/src/identity/firestore-identity-store';
import { IDENTITY_LINK_TTL_SECONDS } from '../../functions/src/identity/policy';
import type { IdentityLinkRecord } from '../../functions/src/identity/types';
import { FirestoreDocumentDatabase } from '../../functions/src/storage/firestore-database';
import { COLLECTIONS } from '../../functions/src/storage/types';
import { buildIdentityLink } from '../helpers/identity-fakes';
import { describeIdentityStoreContract } from '../helpers/identity-store-contract';

const PROJECT_ID = process.env['GCLOUD_PROJECT'] ?? 'demo-otp-infrastructure-service';
const NOW_MS = Date.parse('2026-10-17T00:00:00.000Z');

describe.skipIf(!process.env['FIRESTORE_EMULATOR_HOST'])(
  'FirestoreIdentityStore against the Firestore emulator',
  () => {
    let app: App;
    let firestore: Firestore;
    let database: FirestoreDocumentDatabase;

    beforeAll(() => {
      app = initializeApp({ projectId: PROJECT_ID }, 'identity-store-integration-tests');
      firestore = getFirestore(app);
      database = new FirestoreDocumentDatabase(firestore);
    });

    afterAll(async () => {
      await deleteApp(app);
    });

    beforeEach(async () => {
      await firestore.recursiveDelete(firestore.collection(COLLECTIONS.identityLinks));
    });

    describeIdentityStoreContract('FirestoreIdentityStore (emulator)', () => ({
      store: new FirestoreIdentityStore(database),
      seedLink: async (record: IdentityLinkRecord) => {
        await firestore.collection(COLLECTIONS.identityLinks).doc(record.phoneHash).set(record);
      },
      peekLink: async (phoneHash: string) => {
        const snapshot = await firestore.collection(COLLECTIONS.identityLinks).doc(phoneHash).get();
        return snapshot.exists ? (snapshot.data() as IdentityLinkRecord) : undefined;
      },
    }));

    it('serializes concurrent fills for the same UID without conflicts', async () => {
      const store = new FirestoreIdentityStore(database);
      const phoneHash = 'c'.repeat(64);

      const results = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          store.fillActiveLink({
            phoneHash,
            uid: 'uid_shared',
            challengeId: `c_challenge_${String(index)}`,
            pepperVersion: 1,
            nowMs: NOW_MS,
          }),
        ),
      );

      for (const result of results) {
        expect(['filled', 'refreshed']).toContain(result.outcome);
      }
      const stored = await store.getLink(phoneHash);
      expect(stored).toMatchObject({ status: 'active', uid: 'uid_shared' });
      const snapshot = await firestore.collection(COLLECTIONS.identityLinks).doc(phoneHash).get();
      expect(snapshot.data()?.['ttlAtMs']).toBe(NOW_MS + IDENTITY_LINK_TTL_SECONDS * 1000);
      expect(typeof snapshot.data()?.['ttlAt']?.toMillis).toBe('function');
    });

    it('never repoints under concurrent fills with different UIDs', async () => {
      const store = new FirestoreIdentityStore(database);
      const phoneHash = 'd'.repeat(64);

      const results = await Promise.all([
        store.fillActiveLink({
          phoneHash,
          uid: 'uid_first',
          challengeId: 'c_challenge_1',
          pepperVersion: 1,
          nowMs: NOW_MS,
        }),
        store.fillActiveLink({
          phoneHash,
          uid: 'uid_second',
          challengeId: 'c_challenge_2',
          pepperVersion: 1,
          nowMs: NOW_MS,
        }),
      ]);

      expect(results.filter((result) => result.outcome === 'filled')).toHaveLength(1);
      expect(results.filter((result) => result.outcome === 'conflict')).toHaveLength(1);
      const stored = await store.getLink(phoneHash);
      const winningUid =
        results[0]?.outcome === 'filled' || results[0]?.outcome === 'refreshed'
          ? 'uid_first'
          : 'uid_second';
      expect(stored?.uid).toBe(winningUid);
      expect(stored?.status).toBe('active');
    });

    it('does not overwrite a revoked record', async () => {
      const store = new FirestoreIdentityStore(database);
      const phoneHash = 'e'.repeat(64);
      await firestore
        .collection(COLLECTIONS.identityLinks)
        .doc(phoneHash)
        .set(buildIdentityLink({ phoneHash, status: 'revoked', uid: 'uid_old' }));

      const result = await store.fillActiveLink({
        phoneHash,
        uid: 'uid_new',
        challengeId: 'c_challenge_1',
        pepperVersion: 1,
        nowMs: NOW_MS,
      });

      expect(result).toEqual({ outcome: 'conflict', reason: 'conflict_link_revoked' });
      const snapshot = await firestore.collection(COLLECTIONS.identityLinks).doc(phoneHash).get();
      expect(snapshot.data()).toMatchObject({ status: 'revoked', uid: 'uid_old' });
    });

    it('serializes five concurrent claim acquisitions to one holder', async () => {
      const store = new FirestoreIdentityStore(database);
      const phoneHash = 'f'.repeat(64);

      const results = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          store.acquireCreationClaim({
            phoneHash,
            claimId: `claim_${String(index)}`,
            nowMs: NOW_MS,
            claimExpiresAtMs: NOW_MS + 120_000,
            pepperVersion: 1,
          }),
        ),
      );

      expect(results.filter((result) => result.outcome === 'acquired')).toHaveLength(1);
      expect(results.filter((result) => result.outcome === 'in_progress')).toHaveLength(4);
      const winnerIndex = results.findIndex((result) => result.outcome === 'acquired');
      const stored = await store.getLink(phoneHash);
      expect(stored?.status).toBe('pending_creation');
      expect(stored?.claimId).toBe(`claim_${String(winnerIndex)}`);
    });

    it('serializes concurrent takeovers of an expired claim', async () => {
      const store = new FirestoreIdentityStore(database);
      const phoneHash = 'g'.repeat(64);
      await firestore
        .collection(COLLECTIONS.identityLinks)
        .doc(phoneHash)
        .set(
          buildIdentityLink({
            phoneHash,
            status: 'pending_creation',
            uid: null,
            claimId: 'claim-old',
            claimedAtMs: NOW_MS - 240_000,
            claimExpiresAtMs: NOW_MS - 120_000,
          }),
        );

      const results = await Promise.all([
        store.acquireCreationClaim({
          phoneHash,
          claimId: 'claim-a',
          nowMs: NOW_MS,
          claimExpiresAtMs: NOW_MS + 120_000,
          pepperVersion: 1,
        }),
        store.acquireCreationClaim({
          phoneHash,
          claimId: 'claim-b',
          nowMs: NOW_MS,
          claimExpiresAtMs: NOW_MS + 120_000,
          pepperVersion: 1,
        }),
      ]);

      expect(results.filter((result) => result.outcome === 'reacquired')).toHaveLength(1);
      expect(results.filter((result) => result.outcome === 'in_progress')).toHaveLength(1);
      const stored = await store.getLink(phoneHash);
      expect(['claim-a', 'claim-b']).toContain(stored?.claimId);
      expect(stored?.claimId).not.toBe('claim-old');
    });
  },
);
