import type { IdentityLinkFillResult, IdentityLinkRecord } from './types.js';

/**
 * Persistence port for identity-link records. The Firestore adapter is added
 * in subphase 3.2; subphase 3.1 ships only this contract plus an in-memory test
 * implementation. `fillActiveLink` must be transactional and guarded: it may
 * create or refresh an active link for the given UID but must never re-point,
 * revoke, or take over an existing record.
 */
export interface IdentityStore {
  getLink(phoneHash: string): Promise<IdentityLinkRecord | null>;

  fillActiveLink(input: {
    readonly phoneHash: string;
    readonly uid: string;
    readonly challengeId: string;
    readonly pepperVersion: number;
    readonly nowMs: number;
  }): Promise<IdentityLinkFillResult>;
}
