export interface DocumentRef {
  readonly collection: string;
  readonly id: string;
}

export function docRef(collection: string, id: string): DocumentRef {
  return { collection, id };
}

export interface StoredDocument<T> {
  readonly data: T;
  readonly version: number;
}

export interface TransactionContext {
  read<T>(ref: DocumentRef): Promise<StoredDocument<T> | null>;
  write<T>(ref: DocumentRef, data: T): void;
  delete(ref: DocumentRef): void;
}

export interface DocumentDatabase {
  runTransaction<T>(updateFn: (tx: TransactionContext) => Promise<T>): Promise<T>;
  get<T>(ref: DocumentRef): Promise<StoredDocument<T> | null>;
  set<T>(ref: DocumentRef, data: T): Promise<void>;
}

export const COLLECTIONS = {
  challenges: 'otp_challenges',
  phoneState: 'otp_phone_state',
  requesterState: 'requester_state',
  rateLimits: 'rate_limits',
  deliveryJobs: 'delivery_jobs',
  auditEvents: 'audit_events',
  identityLinks: 'identity_links',
} as const;
