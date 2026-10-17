import type { Firestore } from 'firebase-admin/firestore';
import { Timestamp } from 'firebase-admin/firestore';

import type { DocumentDatabase, DocumentRef, StoredDocument, TransactionContext } from './types.js';

export class FirestoreDocumentDatabase implements DocumentDatabase {
  private readonly firestore: Firestore;

  constructor(firestore: Firestore) {
    this.firestore = firestore;
  }

  async runTransaction<T>(updateFn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return this.firestore.runTransaction(
      async (transaction) => {
        return updateFn({
          read: async <R>(ref: DocumentRef): Promise<StoredDocument<R> | null> => {
            const snapshot = await transaction.get(this.document(ref));
            if (!snapshot.exists) {
              return null;
            }
            return {
              data: snapshot.data() as R,
              version: snapshot.updateTime?.toMillis() ?? 0,
            };
          },
          write: <R>(ref: DocumentRef, data: R): void => {
            transaction.set(this.document(ref), toPersistedData(data));
          },
        });
      },
      { maxAttempts: 20 },
    );
  }

  async set<T>(ref: DocumentRef, data: T): Promise<void> {
    await this.document(ref).set(toPersistedData(data));
  }

  private document(ref: DocumentRef) {
    return this.firestore.collection(ref.collection).doc(ref.id);
  }
}

/**
 * Convention: a numeric top-level `ttlAtMs` field is mirrored to a Firestore
 * `ttlAt` timestamp so operators can attach Firestore TTL policies for
 * retention cleanup. Cleanup is a storage-retention concern only; expiry is
 * always enforced by the engine clock.
 */
function toPersistedData<T>(data: T): Record<string, unknown> {
  const persisted = { ...(data as Record<string, unknown>) };
  const ttlAtMs = persisted['ttlAtMs'];
  if (typeof ttlAtMs === 'number' && Number.isFinite(ttlAtMs)) {
    persisted['ttlAt'] = Timestamp.fromMillis(ttlAtMs);
  }
  return persisted;
}
