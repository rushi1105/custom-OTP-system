import type { AuditSink, NewAuditEvent } from '../audit/audit-log.js';
import type { Logger } from '../logging.js';
import { hashPhone } from '../otp/hashing.js';
import { normalizePhone } from '../otp/phone.js';
import { isPendingCreationClaimActive } from './claims.js';
import { IdentityInvariantError, type IdentityFailureReason } from './errors.js';
import type { IdentityStore } from './identity-store.js';
import type {
  AuthPort,
  AuthUserRecord,
  IdentityLinkFillResult,
  IdentityLinkRecord,
  IdentityResolutionResult,
  ResolveExistingIdentityInput,
} from './types.js';

export interface ResolverInput extends ResolveExistingIdentityInput {
  readonly purpose: string;
  readonly requesterHash: string | null;
}

export interface IdentityResolverDeps {
  readonly store: IdentityStore;
  readonly auth: AuthPort;
  readonly clock: () => Date;
  readonly logger: Logger;
  readonly audit: AuditSink;
  readonly pepper: string;
  readonly pepperVersion: number;
}

interface TryResult<T> {
  readonly ok: boolean;
  readonly value: T | null;
}

/**
 * Existing-identity resolution (docs/IDENTITY_DESIGN.md §3).
 *
 * Security invariants:
 * - Accepts only canonical E.164 admitted through the ID-9 challenge binding;
 *   the phone hash is derived here, never taken from the caller.
 * - The link record is a cache: Firebase Auth is authoritative and every
 *   Auth-confirmed outcome writes or refreshes the link. Any drift fails
 *   closed with an `identity.conflict` audit event and no mutation.
 * - New-identity creation and claim recovery are subphase 3.3; until then,
 *   pending/expired claims fail closed (`unavailable`) rather than risking a
 *   duplicate.
 */
export class IdentityResolver {
  private readonly deps: IdentityResolverDeps;

  constructor(deps: IdentityResolverDeps) {
    this.deps = deps;
  }

  async resolveExisting(input: ResolverInput): Promise<IdentityResolutionResult> {
    const e164 = input.e164;
    if (normalizePhone(e164) !== e164) {
      throw new IdentityInvariantError(
        'resolveExisting requires canonical E.164 (admitted only via the ID-9 challenge binding)',
      );
    }

    const now = this.deps.clock();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const phoneHash = hashPhone(this.deps.pepper, e164);

    const linkRead = await this.tryGetLink(phoneHash);
    if (!linkRead.ok) {
      return this.unavailable('store_unavailable', input, nowIso);
    }
    const link = linkRead.value;

    if (link === null) {
      return this.resolveWithoutLink(input, phoneHash, nowMs, nowIso);
    }

    if (link.status === 'revoked') {
      return this.conflict('conflict_link_revoked', input, phoneHash, link.uid, nowIso);
    }

    if (link.status === 'pending_creation') {
      if (link.claimId === null) {
        return this.conflict('conflict_incomplete_link', input, phoneHash, null, nowIso);
      }
      if (isPendingCreationClaimActive(link, nowMs)) {
        this.deps.logger.warn('identity.claim_pending', { challengeId: input.challengeId });
        return { status: 'unavailable', reason: 'claim_pending' };
      }
      // Expired claim: recovery belongs to the creation protocol (3.3); fail
      // closed here rather than risking a duplicate identity.
      this.deps.logger.warn('identity.claim_expired', { challengeId: input.challengeId });
      return { status: 'unavailable', reason: 'claim_expired' };
    }

    if (link.uid === null) {
      return this.conflict('conflict_incomplete_link', input, phoneHash, null, nowIso);
    }

    const userRead = await this.tryGetUser(link.uid);
    if (!userRead.ok) {
      return this.unavailable('auth_unavailable', input, nowIso);
    }
    const user = userRead.value;
    if (user === null) {
      return this.conflict('conflict_user_missing', input, phoneHash, link.uid, nowIso);
    }
    if (user.disabled) {
      return this.conflict('conflict_user_disabled', input, phoneHash, link.uid, nowIso);
    }
    // Firebase enforces one user per phone number; the equality check below
    // subsumes the uid-mismatch drift case (validated against the Auth emulator
    // in subphase 3.5).
    if (user.phoneNumber !== e164) {
      return this.conflict('conflict_phone_mismatch', input, phoneHash, link.uid, nowIso);
    }

    await this.recordResolved(input, phoneHash, link.uid, 'link', nowIso);
    return { status: 'resolved', uid: link.uid, source: 'link' };
  }

  private async resolveWithoutLink(
    input: ResolverInput,
    phoneHash: string,
    nowMs: number,
    nowIso: string,
  ): Promise<IdentityResolutionResult> {
    const lookup = await this.tryGetUserByPhoneNumber(input.e164);
    if (!lookup.ok) {
      return this.unavailable('auth_unavailable', input, nowIso);
    }
    const user = lookup.value;
    if (user === null) {
      // No authoritative identity owns this phone yet; creation policy is
      // applied by the caller (subphase 3.3).
      this.deps.logger.info('identity.not_found', { challengeId: input.challengeId });
      return { status: 'not_found' };
    }
    if (user.disabled) {
      return this.conflict('conflict_user_disabled', input, phoneHash, user.uid, nowIso);
    }

    const fill = await this.tryFillLink(input, phoneHash, user.uid, nowMs);
    if (fill === null) {
      return this.unavailable('store_unavailable', input, nowIso);
    }
    if (fill.outcome === 'conflict') {
      return this.conflict(fill.reason, input, phoneHash, user.uid, nowIso);
    }

    await this.recordAudit({
      type: 'identity.link.filled',
      occurredAt: nowIso,
      actorType: 'client',
      actorHash: input.requesterHash,
      purpose: input.purpose,
      challengeId: input.challengeId,
      jobId: null,
      phoneHash,
      uid: user.uid,
      outcome: 'success',
      reasonCode: null,
    });
    await this.recordResolved(input, phoneHash, user.uid, 'auth', nowIso);
    return { status: 'resolved', uid: user.uid, source: 'auth' };
  }

  private async recordResolved(
    input: ResolverInput,
    phoneHash: string,
    uid: string,
    source: 'link' | 'auth',
    nowIso: string,
  ): Promise<void> {
    this.deps.logger.info('identity.resolved', { challengeId: input.challengeId, source });
    await this.recordAudit({
      type: 'identity.resolved',
      occurredAt: nowIso,
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
  }

  private async conflict(
    reason: IdentityFailureReason,
    input: ResolverInput,
    phoneHash: string,
    uid: string | null,
    nowIso: string,
  ): Promise<IdentityResolutionResult> {
    this.deps.logger.warn('identity.conflict', { challengeId: input.challengeId, reason });
    const event: NewAuditEvent = {
      type: 'identity.conflict',
      occurredAt: nowIso,
      actorType: 'system',
      actorHash: input.requesterHash,
      purpose: input.purpose,
      challengeId: input.challengeId,
      jobId: null,
      phoneHash,
      outcome: 'failure',
      reasonCode: reason,
    };
    // Omit uid entirely when unknown (D-031 ID-7: only where relevant).
    await this.recordAudit(uid === null ? event : { ...event, uid });
    return { status: 'conflict', reason };
  }

  /**
   * Audit is best-effort for identity resolution (Phase 3.1 review finding F1):
   * a sink failure must never turn a successful resolution (or a settled
   * conflict) into an unexpected request failure. This mirrors SafeAuditSink
   * semantics at the call site so correctness does not depend on how the
   * composition root wraps the sink.
   */
  private async recordAudit(event: NewAuditEvent): Promise<void> {
    try {
      await this.deps.audit.record(event);
    } catch {
      this.deps.logger.warn('audit.write_failed', { eventType: event.type });
    }
  }

  private unavailable(
    reason: IdentityFailureReason,
    input: ResolverInput,
    nowIso: string,
  ): IdentityResolutionResult {
    this.deps.logger.warn('identity.unavailable', {
      challengeId: input.challengeId,
      reason,
      occurredAt: nowIso,
    });
    return { status: 'unavailable', reason };
  }

  private async tryGetLink(phoneHash: string): Promise<TryResult<IdentityLinkRecord>> {
    try {
      return { ok: true, value: await this.deps.store.getLink(phoneHash) };
    } catch {
      return { ok: false, value: null };
    }
  }

  private async tryGetUser(uid: string): Promise<TryResult<AuthUserRecord>> {
    try {
      return { ok: true, value: await this.deps.auth.getUser(uid) };
    } catch {
      return { ok: false, value: null };
    }
  }

  private async tryGetUserByPhoneNumber(e164: string): Promise<TryResult<AuthUserRecord>> {
    try {
      return { ok: true, value: await this.deps.auth.getUserByPhoneNumber(e164) };
    } catch {
      return { ok: false, value: null };
    }
  }

  private async tryFillLink(
    input: ResolverInput,
    phoneHash: string,
    uid: string,
    nowMs: number,
  ): Promise<IdentityLinkFillResult | null> {
    try {
      return await this.deps.store.fillActiveLink({
        phoneHash,
        uid,
        challengeId: input.challengeId,
        pepperVersion: this.deps.pepperVersion,
        nowMs,
      });
    } catch {
      return null;
    }
  }
}
