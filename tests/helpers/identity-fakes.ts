import type { AuditSink, NewAuditEvent } from '../../functions/src/audit/audit-log.js';
import { isPendingCreationClaimActive } from '../../functions/src/identity/claims.js';
import type { IdentityStore } from '../../functions/src/identity/identity-store.js';
import { IdentityResolver } from '../../functions/src/identity/resolver.js';
import { IDENTITY_LINK_TTL_SECONDS } from '../../functions/src/identity/policy.js';
import {
  AuthPhoneAlreadyExistsError,
  AuthUnavailableError,
} from '../../functions/src/identity/errors.js';
import type { IdentityFailureReason } from '../../functions/src/identity/errors.js';
import type {
  AcquireCreationClaimInput,
  AuthPort,
  AuthUserRecord,
  ClaimAcquisitionResult,
  ClaimFinalizationResult,
  ClaimReleaseResult,
  FinalizeCreationClaimInput,
  IdentityLinkFillResult,
  IdentityLinkRecord,
  ReleaseCreationClaimInput,
} from '../../functions/src/identity/types.js';
import { FixedClock } from './fixed-clock.js';
import { RecordingAuditSink } from './recording-audit-sink.js';
import { RecordingLogger } from './recording-logger.js';
import { TEST_PEPPER, TEST_PEPPER_VERSION, TEST_START_ISO } from './engine-fixture.js';

/**
 * In-memory IdentityStore implementing the same guarded semantics required of
 * the Firestore adapter (subphase 3.2). Test-only; exercises the shared store
 * contract in tests/helpers/identity-store-contract.ts.
 */
export class InMemoryIdentityStore implements IdentityStore {
  private readonly links = new Map<string, IdentityLinkRecord>();

  readonly acquireClaimCalls: { phoneHash: string; claimId: string }[] = [];
  readonly finalizeClaimCalls: { phoneHash: string; claimId: string; uid: string }[] = [];
  readonly releaseClaimCalls: { phoneHash: string; claimId: string }[] = [];
  failAcquireClaim = false;
  failFinalizeClaim = false;
  failReleaseClaim = false;
  nextAcquireResults: ClaimAcquisitionResult[] = [];
  onAcquireResult: ((result: ClaimAcquisitionResult) => void) | null = null;
  nextFinalizeResult: ClaimFinalizationResult | null = null;
  onNextFinalizeResult: (() => void) | null = null;

  readonly getLinkCalls: string[] = [];
  readonly fillCalls: string[] = [];
  failGetLink = false;
  failFill = false;
  nextFillConflict: IdentityFailureReason | null = null;

  async getLink(phoneHash: string): Promise<IdentityLinkRecord | null> {
    this.getLinkCalls.push(phoneHash);
    if (this.failGetLink) {
      throw new Error('identity store unavailable');
    }
    const record = this.links.get(phoneHash);
    return record === undefined ? null : { ...record };
  }

  async fillActiveLink(input: {
    readonly phoneHash: string;
    readonly uid: string;
    readonly challengeId: string;
    readonly pepperVersion: number;
    readonly nowMs: number;
  }): Promise<IdentityLinkFillResult> {
    this.fillCalls.push(input.phoneHash);
    if (this.failFill) {
      throw new Error('identity store unavailable');
    }
    if (this.nextFillConflict !== null) {
      return { outcome: 'conflict', reason: this.nextFillConflict };
    }
    const nowIso = new Date(input.nowMs).toISOString();
    const existing = this.links.get(input.phoneHash);
    if (existing === undefined) {
      this.links.set(input.phoneHash, {
        phoneHash: input.phoneHash,
        status: 'active',
        uid: input.uid,
        claimId: null,
        claimedAtMs: null,
        claimExpiresAtMs: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        verifiedAt: nowIso,
        lastChallengeId: input.challengeId,
        pepperVersion: input.pepperVersion,
        ttlAtMs: input.nowMs + IDENTITY_LINK_TTL_SECONDS * 1000,
      });
      return { outcome: 'filled' };
    }
    if (existing.status === 'revoked') {
      return { outcome: 'conflict', reason: 'conflict_link_revoked' };
    }
    if (existing.status === 'pending_creation') {
      return { outcome: 'conflict', reason: 'claim_pending' };
    }
    if (existing.uid !== input.uid) {
      return { outcome: 'conflict', reason: 'conflict_uid_mismatch' };
    }
    this.links.set(input.phoneHash, {
      ...existing,
      updatedAt: nowIso,
      verifiedAt: nowIso,
      lastChallengeId: input.challengeId,
      pepperVersion: input.pepperVersion,
    });
    return { outcome: 'refreshed' };
  }

  seedLink(record: IdentityLinkRecord): void {
    this.links.set(record.phoneHash, { ...record });
  }

  peekLink(phoneHash: string): IdentityLinkRecord | undefined {
    const record = this.links.get(phoneHash);
    return record === undefined ? undefined : { ...record };
  }

  async acquireCreationClaim(input: AcquireCreationClaimInput): Promise<ClaimAcquisitionResult> {
    this.acquireClaimCalls.push({ phoneHash: input.phoneHash, claimId: input.claimId });
    if (this.failAcquireClaim) {
      throw new Error('identity store unavailable');
    }
    if (this.nextAcquireResults.length > 0) {
      const result = this.nextAcquireResults.shift();
      if (result !== undefined) {
        this.onAcquireResult?.(result);
        return result;
      }
    }
    const nowIso = new Date(input.nowMs).toISOString();
    const existing = this.links.get(input.phoneHash);
    if (existing === undefined) {
      this.links.set(input.phoneHash, {
        phoneHash: input.phoneHash,
        status: 'pending_creation',
        uid: null,
        claimId: input.claimId,
        claimedAtMs: input.nowMs,
        claimExpiresAtMs: input.claimExpiresAtMs,
        createdAt: nowIso,
        updatedAt: nowIso,
        verifiedAt: null,
        lastChallengeId: null,
        pepperVersion: input.pepperVersion,
        ttlAtMs: input.nowMs + IDENTITY_LINK_TTL_SECONDS * 1000,
      });
      return { outcome: 'acquired' };
    }
    if (existing.status === 'revoked') {
      return { outcome: 'blocked', reason: 'conflict_link_revoked' };
    }
    if (existing.status === 'active') {
      if (existing.uid === null) {
        return { outcome: 'blocked', reason: 'conflict_incomplete_link' };
      }
      return { outcome: 'active', uid: existing.uid };
    }
    if (existing.claimId === null) {
      return { outcome: 'blocked', reason: 'conflict_incomplete_link' };
    }
    if (isPendingCreationClaimActive(existing, input.nowMs)) {
      return { outcome: 'in_progress' };
    }
    this.links.set(input.phoneHash, {
      ...existing,
      claimId: input.claimId,
      claimedAtMs: input.nowMs,
      claimExpiresAtMs: input.claimExpiresAtMs,
      updatedAt: nowIso,
      pepperVersion: input.pepperVersion,
    });
    return { outcome: 'reacquired' };
  }

  async finalizeCreationClaim(input: FinalizeCreationClaimInput): Promise<ClaimFinalizationResult> {
    this.finalizeClaimCalls.push({
      phoneHash: input.phoneHash,
      claimId: input.claimId,
      uid: input.uid,
    });
    if (this.failFinalizeClaim) {
      throw new Error('identity store unavailable');
    }
    if (this.nextFinalizeResult !== null) {
      const result = this.nextFinalizeResult;
      this.nextFinalizeResult = null;
      this.onNextFinalizeResult?.();
      this.onNextFinalizeResult = null;
      return result;
    }
    const existing = this.links.get(input.phoneHash);
    if (existing === undefined) {
      return { outcome: 'claim_lost' };
    }
    if (existing.status === 'active') {
      return existing.uid === input.uid
        ? { outcome: 'finalized' }
        : { outcome: 'blocked', reason: 'conflict_uid_mismatch' };
    }
    if (existing.status === 'revoked') {
      return { outcome: 'blocked', reason: 'conflict_link_revoked' };
    }
    if (existing.claimId === null) {
      return { outcome: 'blocked', reason: 'conflict_incomplete_link' };
    }
    if (existing.claimId !== input.claimId) {
      return { outcome: 'claim_lost' };
    }
    const nowIso = new Date(input.nowMs).toISOString();
    this.links.set(input.phoneHash, {
      ...existing,
      status: 'active',
      uid: input.uid,
      claimId: null,
      claimedAtMs: null,
      claimExpiresAtMs: null,
      updatedAt: nowIso,
      verifiedAt: nowIso,
      lastChallengeId: input.challengeId,
      pepperVersion: input.pepperVersion,
    });
    return { outcome: 'finalized' };
  }

  async releaseCreationClaim(input: ReleaseCreationClaimInput): Promise<ClaimReleaseResult> {
    this.releaseClaimCalls.push({ phoneHash: input.phoneHash, claimId: input.claimId });
    if (this.failReleaseClaim) {
      throw new Error('identity store unavailable');
    }
    const existing = this.links.get(input.phoneHash);
    if (existing === undefined) {
      return { outcome: 'no_claim' };
    }
    if (
      existing.status !== 'pending_creation' ||
      existing.claimId === null ||
      existing.claimId !== input.claimId
    ) {
      return { outcome: 'not_owner' };
    }
    this.links.delete(input.phoneHash);
    return { outcome: 'released' };
  }
}

/** Test-only Auth port; no Firebase imports anywhere in the domain layer. */
export class FakeAuthPort implements AuthPort {
  private readonly usersByUid = new Map<string, AuthUserRecord>();
  private readonly usersByPhone = new Map<string, string>();
  private sequence = 0;

  failGetUser = false;
  failGetUserByPhoneNumber = false;
  failCreateUser = false;
  lookupByPhoneQueue: (AuthUserRecord | null | Error)[] = [];
  nextCreateError: Error | null = null;
  readonly lookupPhoneCalls: string[] = [];
  readonly createCalls: string[] = [];

  seedUser(user: AuthUserRecord): void {
    this.usersByUid.set(user.uid, { ...user });
    if (user.phoneNumber !== null) {
      this.usersByPhone.set(user.phoneNumber, user.uid);
    }
  }

  get userCount(): number {
    return this.usersByUid.size;
  }

  async getUser(uid: string): Promise<AuthUserRecord | null> {
    if (this.failGetUser) {
      throw new AuthUnavailableError('auth unavailable', 'auth/internal-error');
    }
    const user = this.usersByUid.get(uid);
    return user === undefined ? null : { ...user };
  }

  async getUserByPhoneNumber(e164: string): Promise<AuthUserRecord | null> {
    this.lookupPhoneCalls.push(e164);
    if (this.failGetUserByPhoneNumber) {
      throw new AuthUnavailableError('auth unavailable', 'auth/internal-error');
    }
    if (this.lookupByPhoneQueue.length > 0) {
      const next = this.lookupByPhoneQueue.shift();
      if (next instanceof Error) {
        throw next;
      }
      if (next === null) {
        return null;
      }
      if (next !== undefined) {
        return { ...next };
      }
    }
    const uid = this.usersByPhone.get(e164);
    if (uid === undefined) {
      return null;
    }
    const user = this.usersByUid.get(uid);
    return user === undefined ? null : { ...user };
  }

  async createUserWithPhone(e164: string): Promise<AuthUserRecord> {
    this.createCalls.push(e164);
    if (this.failCreateUser) {
      throw new AuthUnavailableError('auth unavailable', 'auth/internal-error');
    }
    if (this.nextCreateError !== null) {
      const error = this.nextCreateError;
      this.nextCreateError = null;
      throw error;
    }
    if (this.usersByPhone.has(e164)) {
      throw new AuthPhoneAlreadyExistsError(
        'phone already registered',
        'auth/phone-number-already-exists',
      );
    }
    this.sequence += 1;
    const user: AuthUserRecord = {
      uid: `uid_created_${String(this.sequence)}`,
      phoneNumber: e164,
      disabled: false,
    };
    this.seedUser(user);
    return { ...user };
  }
}

/** Audit sink that always fails; used to prove F1 non-interference. */
export class ThrowingAuditSink implements AuditSink {
  readonly attempts: NewAuditEvent[] = [];

  async record(event: NewAuditEvent): Promise<void> {
    this.attempts.push(event);
    throw new Error('audit sink unavailable');
  }
}

export interface IdentityFixture {
  readonly resolver: IdentityResolver;
  readonly store: InMemoryIdentityStore;
  readonly auth: FakeAuthPort;
  readonly clock: FixedClock;
  readonly logger: RecordingLogger;
  readonly audit: RecordingAuditSink;
  readonly pepper: string;
  readonly pepperVersion: number;
}

export function createIdentityFixture(options?: {
  readonly startIso?: string;
  readonly pepper?: string;
  readonly pepperVersion?: number;
}): IdentityFixture {
  const clock = new FixedClock(options?.startIso ?? TEST_START_ISO);
  const store = new InMemoryIdentityStore();
  const auth = new FakeAuthPort();
  const logger = new RecordingLogger();
  const audit = new RecordingAuditSink();
  const resolver = new IdentityResolver({
    store,
    auth,
    clock: () => clock.now(),
    logger,
    audit,
    pepper: options?.pepper ?? TEST_PEPPER,
    pepperVersion: options?.pepperVersion ?? TEST_PEPPER_VERSION,
  });
  return {
    resolver,
    store,
    auth,
    clock,
    logger,
    audit,
    pepper: options?.pepper ?? TEST_PEPPER,
    pepperVersion: options?.pepperVersion ?? TEST_PEPPER_VERSION,
  };
}

export function buildIdentityLink(
  overrides: Partial<IdentityLinkRecord> & { readonly phoneHash: string },
): IdentityLinkRecord {
  const nowIso = TEST_START_ISO;
  return {
    phoneHash: overrides.phoneHash,
    status: 'active',
    uid: null,
    claimId: null,
    claimedAtMs: null,
    claimExpiresAtMs: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    verifiedAt: null,
    lastChallengeId: null,
    pepperVersion: TEST_PEPPER_VERSION,
    ttlAtMs: Date.parse(nowIso) + IDENTITY_LINK_TTL_SECONDS * 1000,
    ...overrides,
  };
}
