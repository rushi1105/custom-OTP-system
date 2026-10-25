import type { AuditSink, NewAuditEvent } from '../audit/audit-log.js';
import type { Logger } from '../logging.js';
import { hashPhone } from '../otp/hashing.js';
import { normalizePhone } from '../otp/phone.js';
import { recordIdentityAudit } from './audit.js';
import {
  AuthPhoneAlreadyExistsError,
  IdentityInvariantError,
  type IdentityFailureReason,
} from './errors.js';
import type { IdentityStore } from './identity-store.js';
import {
  IDENTITY_CLAIM_RETRY_ATTEMPTS,
  IDENTITY_CLAIM_RETRY_BACKOFF_MS,
  IDENTITY_CLAIM_TTL_SECONDS,
} from './policy.js';
import { generateClaimId } from './random.js';
import type { IdentityResolver } from './resolver.js';
import type {
  AuthPort,
  AuthUserRecord,
  EnsureIdentityInput,
  IdentityAssuranceResult,
} from './types.js';

export interface IdentityCreationServiceDeps {
  readonly resolver: IdentityResolver;
  readonly store: IdentityStore;
  readonly auth: AuthPort;
  readonly clock: () => Date;
  readonly logger: Logger;
  readonly audit: AuditSink;
  readonly pepper: string;
  readonly pepperVersion: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

type AcquireAttempt =
  | { readonly kind: 'held'; readonly claimId: string; readonly reacquired: boolean }
  | { readonly kind: 'retry' }
  | { readonly kind: 'conflict'; readonly reason: IdentityFailureReason }
  | { readonly kind: 'unavailable'; readonly reason: IdentityFailureReason };

type FinalizeAttempt =
  | { readonly kind: 'finalized' }
  | { readonly kind: 'claim_lost' }
  | { readonly kind: 'conflict'; readonly reason: IdentityFailureReason }
  | { readonly kind: 'unavailable' };

type PhoneLookup =
  | { readonly ok: true; readonly user: AuthUserRecord | null }
  | { readonly ok: false; readonly reason: IdentityFailureReason };

/**
 * Auth-verified new-identity creation and recovery (Phase 3.3d).
 *
 * Preconditions are established by the caller (3.4): a consumed `sign-in`
 * challenge and the ID-9-validated canonical E.164. This service never accepts
 * a UID, role, or other client identity attribute.
 *
 * Flow (docs/IDENTITY_DESIGN.md §4):
 * 1. resolve existing identities (Auth-authoritative, link as cache);
 * 2. on absence (or an expired claim) acquire a transactional creation claim;
 * 3. re-check Auth immediately after the claim;
 * 4. finalize to an existing user, or create with the canonical phone, then
 *    finalize the claim; recover duplicate-phone/crash/claim-loss cases by
 *    re-resolving Auth, never by deleting users or overwriting links.
 *
 * Post-consumption failures are not retried with the same OTP; this service
 * makes no exactly-once promise.
 */
export class IdentityCreationService {
  private readonly deps: IdentityCreationServiceDeps;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(deps: IdentityCreationServiceDeps) {
    this.deps = deps;
    this.sleep =
      deps.sleep ??
      ((milliseconds) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, milliseconds);
        }));
  }

  async ensureIdentity(input: EnsureIdentityInput): Promise<IdentityAssuranceResult> {
    if (normalizePhone(input.e164) !== input.e164 || input.purpose !== 'sign-in') {
      throw new IdentityInvariantError(
        'ensureIdentity requires a canonical E.164 phone and the sign-in purpose',
      );
    }

    const phoneHash = hashPhone(this.deps.pepper, input.e164);
    const claimId = generateClaimId();

    for (let attempt = 1; attempt <= IDENTITY_CLAIM_RETRY_ATTEMPTS; attempt += 1) {
      const resolution = await this.deps.resolver.resolveExisting({
        e164: input.e164,
        challengeId: input.challengeId,
        purpose: input.purpose,
        requesterHash: input.requesterHash,
      });

      if (resolution.status === 'resolved') {
        return { status: 'resolved', uid: resolution.uid, source: resolution.source };
      }
      if (resolution.status === 'conflict') {
        return { status: 'conflict', reason: resolution.reason };
      }
      if (resolution.status === 'unavailable') {
        if (resolution.reason === 'claim_pending') {
          if (attempt === IDENTITY_CLAIM_RETRY_ATTEMPTS) {
            return this.failUnavailable('claim_pending', input);
          }
          await this.sleep(IDENTITY_CLAIM_RETRY_BACKOFF_MS);
          continue;
        }
        if (resolution.reason !== 'claim_expired') {
          return this.failUnavailable(resolution.reason, input);
        }
        // Expired claim: re-check Auth before the takeover, per the design.
        const preCheck = await this.lookupPhone(input.e164);
        if (!preCheck.ok) {
          return this.failUnavailable(preCheck.reason, input);
        }
        if (preCheck.user !== null && preCheck.user.disabled) {
          return this.conflict('conflict_user_disabled', input, phoneHash, preCheck.user.uid);
        }
      }

      // Resolution is not_found, or an expired claim eligible for takeover.
      const acquisition = await this.acquireClaim(claimId, phoneHash);
      if (acquisition.kind === 'conflict') {
        return this.conflict(acquisition.reason, input, phoneHash, null);
      }
      if (acquisition.kind === 'unavailable') {
        return this.failUnavailable(acquisition.reason, input);
      }
      if (acquisition.kind === 'held') {
        return this.completeWithClaim(input, phoneHash, acquisition);
      }
      if (attempt === IDENTITY_CLAIM_RETRY_ATTEMPTS) {
        return this.failUnavailable('claim_pending', input);
      }
      await this.sleep(IDENTITY_CLAIM_RETRY_BACKOFF_MS);
    }

    return this.failUnavailable('claim_pending', input);
  }

  private async completeWithClaim(
    input: EnsureIdentityInput,
    phoneHash: string,
    acquisition: Extract<AcquireAttempt, { kind: 'held' }>,
  ): Promise<IdentityAssuranceResult> {
    if (acquisition.reacquired) {
      this.deps.logger.warn('identity.claim.expired', { challengeId: input.challengeId });
      await recordIdentityAudit(this.deps.audit, this.deps.logger, {
        type: 'identity.claim.expired',
        occurredAt: this.nowIso(),
        actorType: 'system',
        actorHash: input.requesterHash,
        purpose: input.purpose,
        challengeId: input.challengeId,
        jobId: null,
        phoneHash,
        outcome: 'failure',
        reasonCode: 'claim_expired',
      });
    }

    // Mandatory authoritative re-check immediately after the claim commits.
    const lookup = await this.lookupPhone(input.e164);
    if (!lookup.ok) {
      await this.releaseQuietly(input, phoneHash, acquisition.claimId);
      return this.failUnavailable(lookup.reason, input);
    }

    if (lookup.user !== null) {
      if (lookup.user.disabled) {
        await this.releaseQuietly(input, phoneHash, acquisition.claimId);
        return this.conflict('conflict_user_disabled', input, phoneHash, lookup.user.uid);
      }
      return this.finalizeExistingUser(input, phoneHash, acquisition.claimId, lookup.user.uid);
    }

    let created: AuthUserRecord;
    try {
      created = await this.deps.auth.createUserWithPhone(input.e164);
    } catch (error) {
      if (error instanceof AuthPhoneAlreadyExistsError) {
        return this.recoverDuplicatePhone(input, phoneHash, acquisition.claimId);
      }
      await this.releaseQuietly(input, phoneHash, acquisition.claimId);
      return this.failUnavailable('auth_unavailable', input);
    }

    this.deps.logger.info('identity.created', { challengeId: input.challengeId });
    await recordIdentityAudit(this.deps.audit, this.deps.logger, {
      type: 'identity.created',
      occurredAt: this.nowIso(),
      actorType: 'client',
      actorHash: input.requesterHash,
      purpose: input.purpose,
      challengeId: input.challengeId,
      jobId: null,
      phoneHash,
      uid: created.uid,
      outcome: 'success',
      reasonCode: null,
    });

    const finalize = await this.finalizeClaim(phoneHash, acquisition.claimId, created.uid, input);
    if (finalize.kind === 'finalized') {
      return { status: 'created', uid: created.uid };
    }
    if (finalize.kind === 'claim_lost') {
      return this.recoverAfterClaimLoss(input);
    }
    if (finalize.kind === 'conflict') {
      return this.conflict(finalize.reason, input, phoneHash, created.uid);
    }

    // Store failure after creation: release best-effort so a retry can recover
    // via the authoritative lookup instead of waiting for claim expiry.
    await this.releaseQuietly(input, phoneHash, acquisition.claimId);
    return this.failUnavailable('store_unavailable', input);
  }

  private async recoverDuplicatePhone(
    input: EnsureIdentityInput,
    phoneHash: string,
    claimId: string,
  ): Promise<IdentityAssuranceResult> {
    const lookup = await this.lookupPhone(input.e164);
    if (!lookup.ok) {
      await this.releaseQuietly(input, phoneHash, claimId);
      return this.failUnavailable(lookup.reason, input);
    }
    if (lookup.user === null) {
      await this.releaseQuietly(input, phoneHash, claimId);
      return this.conflict('phone_already_exists_unresolved', input, phoneHash, null);
    }
    if (lookup.user.disabled) {
      await this.releaseQuietly(input, phoneHash, claimId);
      return this.conflict('conflict_user_disabled', input, phoneHash, lookup.user.uid);
    }
    return this.finalizeExistingUser(input, phoneHash, claimId, lookup.user.uid);
  }

  private async finalizeExistingUser(
    input: EnsureIdentityInput,
    phoneHash: string,
    claimId: string,
    uid: string,
  ): Promise<IdentityAssuranceResult> {
    const finalize = await this.finalizeClaim(phoneHash, claimId, uid, input);
    if (finalize.kind === 'finalized') {
      this.deps.logger.info('identity.recovered', { challengeId: input.challengeId });
      await recordIdentityAudit(this.deps.audit, this.deps.logger, {
        type: 'identity.resolved',
        occurredAt: this.nowIso(),
        actorType: 'client',
        actorHash: input.requesterHash,
        purpose: input.purpose,
        challengeId: input.challengeId,
        jobId: null,
        phoneHash,
        uid,
        outcome: 'success',
        reasonCode: null,
      });
      return { status: 'recovered', uid };
    }
    if (finalize.kind === 'claim_lost') {
      return this.recoverAfterClaimLoss(input);
    }
    if (finalize.kind === 'conflict') {
      return this.conflict(finalize.reason, input, phoneHash, uid);
    }

    await this.releaseQuietly(input, phoneHash, claimId);
    return this.failUnavailable('store_unavailable', input);
  }

  /**
   * The claim changed hands after this attempt mutated Auth (created a user or
   * found one). Never delete the user and never create another: re-resolve the
   * authoritative state and fail closed if it cannot be established.
   */
  private async recoverAfterClaimLoss(
    input: EnsureIdentityInput,
  ): Promise<IdentityAssuranceResult> {
    this.deps.logger.warn('identity.claim_lost', { challengeId: input.challengeId });
    const resolution = await this.deps.resolver.resolveExisting({
      e164: input.e164,
      challengeId: input.challengeId,
      purpose: input.purpose,
      requesterHash: input.requesterHash,
    });
    if (resolution.status === 'resolved') {
      return { status: 'resolved', uid: resolution.uid, source: resolution.source };
    }
    if (resolution.status === 'conflict') {
      return { status: 'conflict', reason: resolution.reason };
    }
    if (resolution.status === 'unavailable') {
      const reason = resolution.reason === 'claim_expired' ? 'claim_pending' : resolution.reason;
      return this.failUnavailable(reason, input);
    }
    return this.failUnavailable('claim_pending', input);
  }

  private async acquireClaim(claimId: string, phoneHash: string): Promise<AcquireAttempt> {
    const nowMs = this.deps.clock().getTime();
    try {
      const result = await this.deps.store.acquireCreationClaim({
        phoneHash,
        claimId,
        nowMs,
        claimExpiresAtMs: nowMs + IDENTITY_CLAIM_TTL_SECONDS * 1000,
        pepperVersion: this.deps.pepperVersion,
      });
      if (result.outcome === 'acquired') {
        return { kind: 'held', claimId, reacquired: false };
      }
      if (result.outcome === 'reacquired') {
        return { kind: 'held', claimId, reacquired: true };
      }
      if (result.outcome === 'blocked') {
        return { kind: 'conflict', reason: result.reason };
      }
      return { kind: 'retry' };
    } catch {
      return { kind: 'unavailable', reason: 'store_unavailable' };
    }
  }

  private async finalizeClaim(
    phoneHash: string,
    claimId: string,
    uid: string,
    input: EnsureIdentityInput,
  ): Promise<FinalizeAttempt> {
    try {
      const result = await this.deps.store.finalizeCreationClaim({
        phoneHash,
        claimId,
        uid,
        challengeId: input.challengeId,
        pepperVersion: this.deps.pepperVersion,
        nowMs: this.deps.clock().getTime(),
      });
      if (result.outcome === 'finalized') {
        return { kind: 'finalized' };
      }
      if (result.outcome === 'claim_lost') {
        return { kind: 'claim_lost' };
      }
      return { kind: 'conflict', reason: result.reason };
    } catch {
      return { kind: 'unavailable' };
    }
  }

  private async lookupPhone(e164: string): Promise<PhoneLookup> {
    try {
      return { ok: true, user: await this.deps.auth.getUserByPhoneNumber(e164) };
    } catch {
      return { ok: false, reason: 'auth_unavailable' };
    }
  }

  private async releaseQuietly(
    input: EnsureIdentityInput,
    phoneHash: string,
    claimId: string,
  ): Promise<void> {
    try {
      await this.deps.store.releaseCreationClaim({ phoneHash, claimId });
    } catch {
      this.deps.logger.warn('identity.claim.release_failed', {
        challengeId: input.challengeId,
      });
    }
  }

  private async conflict(
    reason: IdentityFailureReason,
    input: EnsureIdentityInput,
    phoneHash: string,
    uid: string | null,
  ): Promise<IdentityAssuranceResult> {
    this.deps.logger.warn('identity.conflict', { challengeId: input.challengeId });
    const event: NewAuditEvent = {
      type: 'identity.conflict',
      occurredAt: this.nowIso(),
      actorType: 'system',
      actorHash: input.requesterHash,
      purpose: input.purpose,
      challengeId: input.challengeId,
      jobId: null,
      phoneHash,
      outcome: 'failure',
      reasonCode: reason,
    };
    await recordIdentityAudit(
      this.deps.audit,
      this.deps.logger,
      uid === null ? event : { ...event, uid },
    );
    return { status: 'conflict', reason };
  }

  private failUnavailable(
    reason: IdentityFailureReason,
    input: EnsureIdentityInput,
  ): IdentityAssuranceResult {
    this.deps.logger.warn('identity.unavailable', { challengeId: input.challengeId });
    return { status: 'unavailable', reason };
  }

  private nowIso(): string {
    return new Date(this.deps.clock().getTime()).toISOString();
  }
}
