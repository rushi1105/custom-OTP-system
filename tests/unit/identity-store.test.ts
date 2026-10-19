import { describeIdentityStoreContract } from '../helpers/identity-store-contract';
import { InMemoryIdentityStore } from '../helpers/identity-fakes';

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
