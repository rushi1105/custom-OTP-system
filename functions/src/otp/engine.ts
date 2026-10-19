import type { DeliveryRequest } from '@otp-infra/contracts';

import type { AuditSink, NewAuditEvent } from '../audit/audit-log.js';
import type { Dispatcher } from '../delivery/dispatcher.js';
import type { Logger } from '../logging.js';
import { COLLECTIONS, docRef, type DocumentDatabase } from '../storage/types.js';
import { hashCode, hashPhone, verifyCodeHash } from './hashing.js';
import { normalizePhone } from './phone.js';
import { isOtpPurpose, type OtpPolicy, type OtpPurpose } from './policy.js';
import {
  generateChallengeId,
  generateJobId,
  generateOtpCode,
  generateSalt,
  isValidChallengeId,
  isValidOtpCode,
} from './random.js';
import { evaluateWindow, windowStartMs } from './state.js';
import type {
  ChallengeRecord,
  ChallengeVoidReason,
  DeliveryJobRecord,
  GlobalRequestBucketRecord,
  PhoneStateRecord,
  RequesterStateRecord,
  RequestOutcome,
  VerificationFailureReason,
  VerifyOutcome,
} from './types.js';

export interface OtpEngineDeps {
  readonly db: DocumentDatabase;
  readonly dispatcher: Dispatcher;
  readonly clock: () => Date;
  readonly logger: Logger;
  readonly audit: AuditSink;
  readonly policy: OtpPolicy;
  readonly pepper: string;
  readonly pepperVersion: number;
}

type RequestTransactionResult =
  | { readonly blocked: null }
  | { readonly blocked: 'cooldown'; readonly retryAfterSeconds: number }
  | {
      readonly blocked: 'limited';
      readonly scope: 'phone' | 'requester' | 'global';
      readonly retryAfterSeconds: number;
    };

type VerifyTransactionResult =
  | { readonly kind: 'verified'; readonly phoneHash: string }
  | {
      readonly kind: 'invalid';
      readonly reason: VerificationFailureReason;
      readonly known: { readonly challengeId: string; readonly phoneHash: string } | null;
    }
  | { readonly kind: 'rate_limited'; readonly retryAfterSeconds: number };

export class OtpEngine {
  private readonly deps: OtpEngineDeps;

  constructor(deps: OtpEngineDeps) {
    this.deps = deps;
  }

  async requestChallenge(input: {
    readonly phoneRaw: unknown;
    readonly purpose: unknown;
    readonly requesterHash: string;
  }): Promise<RequestOutcome> {
    const phone = normalizePhone(input.phoneRaw);
    if (phone === null || !isOtpPurpose(input.purpose)) {
      return { outcome: 'invalid_input' };
    }
    const purpose = input.purpose;
    const { policy, pepper, db, dispatcher } = this.deps;
    const now = this.deps.clock();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    const phoneHash = hashPhone(pepper, phone);
    const challengeId = generateChallengeId();
    const jobId = generateJobId();
    const salt = generateSalt();
    const code = generateOtpCode(policy.codeLength);
    const expiresAtMs = nowMs + policy.ttlSeconds * 1000;
    const cooldownUntilMs = nowMs + policy.resendCooldownSeconds * 1000;
    const challengeTtlMs = expiresAtMs + policy.retentionSeconds * 1000;

    const challenge: ChallengeRecord = {
      challengeId,
      purpose,
      phoneHash,
      pepperVersion: this.deps.pepperVersion,
      codeHash: hashCode(pepper, salt, purpose, code),
      salt,
      codeLength: policy.codeLength,
      attempts: 0,
      maxAttempts: policy.maxAttempts,
      status: 'pending',
      createdAt: nowIso,
      expiresAt: new Date(expiresAtMs).toISOString(),
      deliveryJobId: jobId,
      requesterHash: input.requesterHash,
      ttlAtMs: challengeTtlMs,
    };

    const job: DeliveryJobRecord = {
      jobId,
      challengeId,
      providerId: dispatcher.providerId,
      channel: 'sms',
      status: 'pending',
      dedupeKey: challengeId,
      attempts: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
      ttlAtMs: challengeTtlMs,
    };

    const txResult = await db.runTransaction<RequestTransactionResult>(async (tx) => {
      const phoneStateRef = docRef(COLLECTIONS.phoneState, phoneHash);
      const requesterStateRef = docRef(COLLECTIONS.requesterState, input.requesterHash);

      const phoneState = (await tx.read<PhoneStateRecord>(phoneStateRef))?.data ?? null;
      const requesterState = (await tx.read<RequesterStateRecord>(requesterStateRef))?.data ?? null;

      const globalWindowStart = windowStartMs(nowMs, 60);
      const globalRef = docRef(COLLECTIONS.rateLimits, `req-global-${globalWindowStart}`);
      const globalBucket = (await tx.read<GlobalRequestBucketRecord>(globalRef))?.data ?? null;

      const activeChallenge =
        phoneState?.activeChallengeId != null
          ? ((
              await tx.read<ChallengeRecord>(
                docRef(COLLECTIONS.challenges, phoneState.activeChallengeId),
              )
            )?.data ?? null)
          : null;

      const globalEvaluation = evaluateWindow(
        globalBucket?.windowStartMs ?? null,
        globalBucket?.count ?? 0,
        nowMs,
        { max: policy.globalRequestsPerMinute, windowSeconds: 60 },
      );
      if (globalEvaluation.blocked) {
        return {
          blocked: 'limited',
          scope: 'global',
          retryAfterSeconds: globalEvaluation.retryAfterSeconds,
        };
      }

      const requesterEvaluation = evaluateWindow(
        requesterState?.requestWindowStartMs ?? null,
        requesterState?.requestWindowCount ?? 0,
        nowMs,
        policy.requesterRequestLimit,
      );
      if (requesterEvaluation.blocked) {
        return {
          blocked: 'limited',
          scope: 'requester',
          retryAfterSeconds: requesterEvaluation.retryAfterSeconds,
        };
      }

      const phoneEvaluation = evaluateWindow(
        phoneState?.requestWindowStartMs ?? null,
        phoneState?.requestWindowCount ?? 0,
        nowMs,
        policy.phoneRequestLimit,
      );
      if (phoneEvaluation.blocked) {
        return {
          blocked: 'limited',
          scope: 'phone',
          retryAfterSeconds: phoneEvaluation.retryAfterSeconds,
        };
      }

      if (phoneState?.cooldownUntilMs != null && phoneState.cooldownUntilMs > nowMs) {
        return {
          blocked: 'cooldown',
          retryAfterSeconds: Math.max(1, Math.ceil((phoneState.cooldownUntilMs - nowMs) / 1000)),
        };
      }

      if (activeChallenge !== null && activeChallenge.status === 'pending') {
        tx.write(
          docRef(COLLECTIONS.challenges, activeChallenge.challengeId),
          voidChallengeRecord(activeChallenge, 'superseded', nowIso),
        );
      }

      tx.write(docRef(COLLECTIONS.challenges, challengeId), challenge);
      tx.write(docRef(COLLECTIONS.deliveryJobs, jobId), job);
      tx.write(phoneStateRef, {
        phoneHash,
        activeChallengeId: challengeId,
        cooldownUntilMs,
        requestWindowStartMs: phoneEvaluation.windowStartMs,
        requestWindowCount: phoneEvaluation.count,
        lastRequestedAtMs: nowMs,
        ttlAtMs: nowMs + policy.retentionSeconds * 1000,
      } satisfies PhoneStateRecord);
      tx.write(requesterStateRef, {
        requesterHash: input.requesterHash,
        requestWindowStartMs: requesterEvaluation.windowStartMs,
        requestWindowCount: requesterEvaluation.count,
        verifyWindowStartMs: requesterState?.verifyWindowStartMs ?? 0,
        verifyWindowCount: requesterState?.verifyWindowCount ?? 0,
        ttlAtMs: nowMs + policy.retentionSeconds * 1000,
      } satisfies RequesterStateRecord);
      tx.write(globalRef, {
        bucketKey: globalRef.id,
        windowStartMs: globalEvaluation.windowStartMs,
        count: globalEvaluation.count,
        ttlAtMs: globalEvaluation.windowStartMs + 3_600_000,
      } satisfies GlobalRequestBucketRecord);

      return { blocked: null };
    });

    if (txResult.blocked !== null) {
      const scope = txResult.blocked === 'cooldown' ? 'cooldown' : txResult.scope;
      await this.deps.audit.record({
        type: 'otp.request.blocked',
        occurredAt: nowIso,
        actorType: 'client',
        actorHash: input.requesterHash,
        purpose,
        challengeId: null,
        jobId: null,
        phoneHash,
        outcome: 'failure',
        reasonCode: scope,
      });
      this.deps.logger.info('otp.request.blocked', { scope });
      if (txResult.blocked === 'cooldown') {
        return { outcome: 'resend_cooldown', retryAfterSeconds: txResult.retryAfterSeconds };
      }
      return {
        outcome: 'rate_limited',
        scope: txResult.scope,
        retryAfterSeconds: txResult.retryAfterSeconds,
      };
    }

    const deliveryRequest: DeliveryRequest = {
      jobId,
      channel: 'sms',
      destination: phone,
      body: buildOtpMessage(code, policy.ttlSeconds),
      expiresAt: challenge.expiresAt,
      metadata: { challengeId, purpose },
    };

    const receipt = await dispatcher.dispatch(job, deliveryRequest);

    if (receipt.status === 'accepted') {
      await this.deps.audit.record({
        type: 'otp.request.created',
        occurredAt: nowIso,
        actorType: 'client',
        actorHash: input.requesterHash,
        purpose,
        challengeId,
        jobId,
        phoneHash,
        outcome: 'success',
        reasonCode: null,
      });
      this.deps.logger.info('otp.request.created', { challengeId, jobId });
      return {
        outcome: 'created',
        challengeId,
        expiresInSeconds: policy.ttlSeconds,
        resendAfterSeconds: policy.resendCooldownSeconds,
      };
    }

    const voidReason: ChallengeVoidReason =
      receipt.status === 'rejected' ? 'delivery_rejected' : 'delivery_failed';
    await this.voidPendingChallenge(challengeId, voidReason);
    await this.deps.audit.record({
      type: 'otp.request.delivery_failed',
      occurredAt: nowIso,
      actorType: 'system',
      actorHash: input.requesterHash,
      purpose,
      challengeId,
      jobId,
      phoneHash,
      outcome: 'failure',
      reasonCode: receipt.error?.code ?? receipt.status,
    });
    this.deps.logger.warn('otp.request.delivery_failed', {
      challengeId,
      jobId,
      deliveryStatus: receipt.status,
      errorCode: receipt.error?.code ?? null,
    });
    return {
      outcome: 'delivery_unavailable',
      retryAfterSeconds: policy.deliveryUnavailableRetryAfterSeconds,
    };
  }

  async verifyChallenge(input: {
    readonly challengeId: unknown;
    readonly code: unknown;
    readonly purpose: unknown;
    readonly phoneRaw: unknown;
    readonly requesterHash: string;
  }): Promise<VerifyOutcome> {
    const { policy, pepper, pepperVersion, db } = this.deps;
    if (
      !isValidChallengeId(input.challengeId) ||
      !isOtpPurpose(input.purpose) ||
      !isValidOtpCode(input.code, policy.codeLength)
    ) {
      return { outcome: 'invalid_input' };
    }
    const phone = normalizePhone(input.phoneRaw);
    if (phone === null) {
      // The supplied phone is a locator for the already-created challenge, not
      // an identity input. Invalid/malformed values fail with the same generic
      // surface as a mismatch and never touch challenge state (ID-9).
      return { outcome: 'invalid', internalReason: 'phone_invalid' };
    }
    const expectedPhoneHash = hashPhone(pepper, phone);
    const challengeId = input.challengeId;
    const code = input.code;
    const purpose: OtpPurpose = input.purpose;
    const now = this.deps.clock();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    const txResult = await db.runTransaction<VerifyTransactionResult>(async (tx) => {
      const challengeRef = docRef(COLLECTIONS.challenges, challengeId);
      const requesterRef = docRef(COLLECTIONS.requesterState, input.requesterHash);

      const challengeSnapshot = await tx.read<ChallengeRecord>(challengeRef);
      const requesterState = (await tx.read<RequesterStateRecord>(requesterRef))?.data ?? null;

      const verifyEvaluation = evaluateWindow(
        requesterState?.verifyWindowStartMs ?? null,
        requesterState?.verifyWindowCount ?? 0,
        nowMs,
        policy.requesterVerifyLimit,
      );
      if (verifyEvaluation.blocked) {
        return { kind: 'rate_limited', retryAfterSeconds: verifyEvaluation.retryAfterSeconds };
      }

      // ID-9 phone binding: compare inside the consuming transaction, before any
      // write. A mismatch must leave the challenge and rate-limit state
      // unchanged. Rotated challenges fall through to the existing
      // pepper_version_mismatch handling below (an old hash cannot be compared
      // against the current pepper).
      if (
        challengeSnapshot !== null &&
        challengeSnapshot.data.pepperVersion === pepperVersion &&
        challengeSnapshot.data.phoneHash !== expectedPhoneHash
      ) {
        return {
          kind: 'invalid',
          reason: 'phone_mismatch',
          known: { challengeId, phoneHash: challengeSnapshot.data.phoneHash },
        };
      }

      tx.write(requesterRef, {
        requesterHash: input.requesterHash,
        requestWindowStartMs: requesterState?.requestWindowStartMs ?? 0,
        requestWindowCount: requesterState?.requestWindowCount ?? 0,
        verifyWindowStartMs: verifyEvaluation.windowStartMs,
        verifyWindowCount: verifyEvaluation.count,
        ttlAtMs: nowMs + policy.retentionSeconds * 1000,
      } satisfies RequesterStateRecord);

      if (challengeSnapshot === null) {
        return { kind: 'invalid', reason: 'not_found', known: null };
      }

      const challenge = challengeSnapshot.data;
      const known = { challengeId, phoneHash: challenge.phoneHash };

      if (challenge.status === 'consumed') {
        return { kind: 'invalid', reason: 'consumed', known };
      }
      if (challenge.status === 'locked') {
        return { kind: 'invalid', reason: 'locked', known };
      }
      if (challenge.status === 'void') {
        return { kind: 'invalid', reason: 'voided', known };
      }
      if (challenge.status === 'expired') {
        return { kind: 'invalid', reason: 'expired', known };
      }
      if (challenge.purpose !== purpose) {
        return { kind: 'invalid', reason: 'purpose_mismatch', known };
      }
      if (challenge.pepperVersion !== pepperVersion) {
        return { kind: 'invalid', reason: 'pepper_version_mismatch', known };
      }
      if (Date.parse(challenge.expiresAt) <= nowMs) {
        tx.write(challengeRef, {
          ...challenge,
          status: 'expired',
          ttlAtMs: nowMs + policy.retentionSeconds * 1000,
        } satisfies ChallengeRecord);
        return { kind: 'invalid', reason: 'expired', known };
      }

      if (verifyCodeHash(pepper, challenge.salt, purpose, code, challenge.codeHash)) {
        tx.write(challengeRef, {
          ...challenge,
          status: 'consumed',
          consumedAt: nowIso,
          ttlAtMs: nowMs + policy.retentionSeconds * 1000,
        } satisfies ChallengeRecord);
        return { kind: 'verified', phoneHash: challenge.phoneHash };
      }

      const attempts = challenge.attempts + 1;
      const locked = attempts >= challenge.maxAttempts;
      tx.write(challengeRef, {
        ...challenge,
        attempts,
        status: locked ? 'locked' : 'pending',
        ...(locked ? { lockedAt: nowIso } : {}),
      } satisfies ChallengeRecord);
      return { kind: 'invalid', reason: locked ? 'locked' : 'wrong_code', known };
    });

    if (txResult.kind === 'verified') {
      await this.deps.audit.record({
        type: 'otp.verification.succeeded',
        occurredAt: nowIso,
        actorType: 'client',
        actorHash: input.requesterHash,
        purpose,
        challengeId,
        jobId: null,
        phoneHash: txResult.phoneHash,
        outcome: 'success',
        reasonCode: null,
      });
      this.deps.logger.info('otp.verification.succeeded', { challengeId });
      return { outcome: 'verified', purpose };
    }

    if (txResult.kind === 'rate_limited') {
      await this.deps.audit.record({
        type: 'otp.verification.failed',
        occurredAt: nowIso,
        actorType: 'client',
        actorHash: input.requesterHash,
        purpose,
        challengeId,
        jobId: null,
        phoneHash: null,
        outcome: 'failure',
        reasonCode: 'rate_limited',
      });
      this.deps.logger.warn('otp.verification.rate_limited', { challengeId });
      return { outcome: 'rate_limited', retryAfterSeconds: txResult.retryAfterSeconds };
    }

    const auditType: NewAuditEvent['type'] =
      txResult.reason === 'locked'
        ? 'otp.challenge.locked'
        : txResult.reason === 'expired'
          ? 'otp.challenge.expired'
          : 'otp.verification.failed';
    await this.deps.audit.record({
      type: auditType,
      occurredAt: nowIso,
      actorType: 'client',
      actorHash: input.requesterHash,
      purpose,
      challengeId: txResult.known?.challengeId ?? challengeId,
      jobId: null,
      phoneHash: txResult.known?.phoneHash ?? null,
      outcome: 'failure',
      reasonCode: txResult.reason,
    });
    this.deps.logger.info('otp.verification.failed', {
      challengeId,
      reason: txResult.reason,
    });
    return { outcome: 'invalid', internalReason: txResult.reason };
  }

  private async voidPendingChallenge(
    challengeId: string,
    reason: ChallengeVoidReason,
  ): Promise<void> {
    const { db, policy } = this.deps;
    const nowMs = this.deps.clock().getTime();
    const nowIso = new Date(nowMs).toISOString();
    const voided = await db.runTransaction<ChallengeRecord | null>(async (tx) => {
      const challengeRef = docRef(COLLECTIONS.challenges, challengeId);
      const snapshot = await tx.read<ChallengeRecord>(challengeRef);
      if (snapshot === null || snapshot.data.status !== 'pending') {
        return null;
      }
      const challenge = snapshot.data;
      const phoneStateRef = docRef(COLLECTIONS.phoneState, challenge.phoneHash);
      const phoneStateSnapshot = await tx.read<PhoneStateRecord>(phoneStateRef);
      tx.write(challengeRef, {
        ...challenge,
        status: 'void',
        voidReason: reason,
        voidedAt: nowIso,
        ttlAtMs: nowMs + policy.retentionSeconds * 1000,
      } satisfies ChallengeRecord);
      if (
        phoneStateSnapshot !== null &&
        phoneStateSnapshot.data.activeChallengeId === challengeId
      ) {
        tx.write(phoneStateRef, {
          ...phoneStateSnapshot.data,
          activeChallengeId: null,
          cooldownUntilMs: null,
        } satisfies PhoneStateRecord);
      }
      return challenge;
    });

    if (voided !== null) {
      await this.deps.audit.record({
        type: 'otp.challenge.voided',
        occurredAt: nowIso,
        actorType: 'system',
        actorHash: voided.requesterHash,
        purpose: voided.purpose,
        challengeId,
        jobId: voided.deliveryJobId,
        phoneHash: voided.phoneHash,
        outcome: 'failure',
        reasonCode: reason,
      });
    }
  }
}

function voidChallengeRecord(
  challenge: ChallengeRecord,
  reason: ChallengeVoidReason,
  nowIso: string,
): ChallengeRecord {
  return {
    ...challenge,
    status: 'void',
    voidReason: reason,
    voidedAt: nowIso,
  };
}

function buildOtpMessage(code: string, ttlSeconds: number): string {
  const minutes = Math.max(1, Math.round(ttlSeconds / 60));
  return `Your verification code is ${code}. It expires in ${minutes} minute${minutes === 1 ? '' : 's'}. Never share this code.`;
}
