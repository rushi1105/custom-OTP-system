import type {
  DocumentDatabase,
  DocumentRef,
  TransactionContext,
} from '../../functions/src/storage/types.js';

interface StoredEntry {
  data: unknown;
  version: number;
}

const MAX_TRANSACTION_ATTEMPTS = 50;

/**
 * In-memory implementation of DocumentDatabase with optimistic concurrency
 * that mirrors Firestore transaction semantics: a transaction detects that a
 * document it read changed before commit and retries, so read-modify-write
 * races resolve to a single winner.
 */
export class InMemoryDocumentDatabase implements DocumentDatabase {
  private readonly entries = new Map<string, StoredEntry>();

  async runTransaction<T>(updateFn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      const readVersions = new Map<string, number>();
      const pendingWrites = new Map<string, unknown>();

      const tx: TransactionContext = {
        read: async <R>(ref: DocumentRef): Promise<{ data: R; version: number } | null> => {
          const key = storageKey(ref);
          const current = this.entries.get(key);
          readVersions.set(key, current?.version ?? -1);
          return current === undefined
            ? null
            : { data: current.data as R, version: current.version };
        },
        write: <R>(ref: DocumentRef, data: R): void => {
          pendingWrites.set(storageKey(ref), data);
        },
      };

      const result = await updateFn(tx);

      let conflicted = false;
      for (const [key, versionAtRead] of readVersions) {
        const current = this.entries.get(key);
        if ((current?.version ?? -1) !== versionAtRead) {
          conflicted = true;
          break;
        }
      }

      if (!conflicted) {
        for (const [key, data] of pendingWrites) {
          const current = this.entries.get(key);
          this.entries.set(key, { data, version: (current?.version ?? -1) + 1 });
        }
        return result;
      }

      await Promise.resolve();
    }
    throw new Error('in-memory transaction retry limit exceeded');
  }

  async set<T>(ref: DocumentRef, data: T): Promise<void> {
    const key = storageKey(ref);
    const current = this.entries.get(key);
    this.entries.set(key, { data, version: (current?.version ?? -1) + 1 });
  }

  getDocument<T>(ref: DocumentRef): T | undefined {
    return this.entries.get(storageKey(ref))?.data as T | undefined;
  }

  countCollection(collection: string): number {
    const prefix = `${collection}/`;
    let count = 0;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        count += 1;
      }
    }
    return count;
  }

  dump(): string {
    const plain: Record<string, unknown> = {};
    for (const [key, entry] of this.entries) {
      plain[key] = entry.data;
    }
    return JSON.stringify(plain);
  }
}

function storageKey(ref: DocumentRef): string {
  return `${ref.collection}/${ref.id}`;
}
