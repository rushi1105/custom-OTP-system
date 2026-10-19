import { describe, expect, it } from 'vitest';

import { FirestoreIdentityStore } from '../../functions/src/identity/firestore-identity-store';
import type { DocumentDatabase, DocumentRef } from '../../functions/src/storage/types';
import { InMemoryIdentityStore } from '../helpers/identity-fakes';
import { describeIdentityStoreContract } from '../helpers/identity-store-contract';

// The harness factory is invoked once per contract test, so constructing the
// store inside this callback guarantees a fresh instance for every test (no
// reliance on execution order).
describeIdentityStoreContract('InMemoryIdentityStore', () => {
  const store = new InMemoryIdentityStore();
  return {
    store,
    seedLink: async (record) => {
      store.seedLink(record);
    },
    peekLink: async (phoneHash) => store.peekLink(phoneHash),
  };
});

const PHONE_HASH = 'a'.repeat(64);

function failingDatabase(): DocumentDatabase {
  return {
    runTransaction: async () => {
      throw new Error('identity database unavailable');
    },
    get: async () => {
      throw new Error('identity database unavailable');
    },
    set: async <T>(_ref: DocumentRef, _data: T): Promise<void> => {
      throw new Error('identity database unavailable');
    },
  };
}

describe('FirestoreIdentityStore failure propagation', () => {
  const store = new FirestoreIdentityStore(failingDatabase());

  it('propagates claim acquisition failures', async () => {
    await expect(
      store.acquireCreationClaim({
        phoneHash: PHONE_HASH,
        claimId: 'claim-a',
        nowMs: 1_800_000_000_000,
        claimExpiresAtMs: 1_800_000_120_000,
        pepperVersion: 1,
      }),
    ).rejects.toThrow('identity database unavailable');
  });

  it('propagates claim finalization failures', async () => {
    await expect(
      store.finalizeCreationClaim({
        phoneHash: PHONE_HASH,
        claimId: 'claim-a',
        uid: 'uid_created',
        challengeId: 'c_challenge_1',
        pepperVersion: 1,
        nowMs: 1_800_000_001_000,
      }),
    ).rejects.toThrow('identity database unavailable');
  });

  it('propagates claim release failures', async () => {
    await expect(
      store.releaseCreationClaim({ phoneHash: PHONE_HASH, claimId: 'claim-a' }),
    ).rejects.toThrow('identity database unavailable');
  });
});
