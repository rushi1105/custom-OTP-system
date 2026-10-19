import { describe, expect, it } from 'vitest';

import { IdentityInvariantError } from '../../functions/src/identity/errors';
import { IdentityResolver } from '../../functions/src/identity/resolver';
import { hashPhone } from '../../functions/src/otp/hashing';
import {
  buildIdentityLink,
  createIdentityFixture,
  ThrowingAuditSink,
  type IdentityFixture,
} from '../helpers/identity-fakes';

const PHONE = '+919876543210';
const OTHER_PHONE = '+919999999999';
const CHALLENGE_ID = 'c_AAAAAAAAAAAAAAAAAAAAAA';
const REQUESTER = 'requester-1';

function resolve(
  fixture: IdentityFixture,
  overrides: Partial<{
    e164: string;
    challengeId: string;
    purpose: string;
    requesterHash: string | null;
  }> = {},
) {
  return fixture.resolver.resolveExisting({
    e164: PHONE,
    challengeId: CHALLENGE_ID,
    purpose: 'sign-in',
    requesterHash: REQUESTER,
    ...overrides,
  });
}

describe('IdentityResolver.resolveExisting — link cache paths', () => {
  it('resolves an active link backed by a valid Auth user without refilling', async () => {
    const fixture = createIdentityFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.auth.seedUser({ uid: 'uid_existing', phoneNumber: PHONE, disabled: false });
    fixture.store.seedLink(buildIdentityLink({ phoneHash, uid: 'uid_existing' }));

    const result = await resolve(fixture);

    expect(result).toEqual({ status: 'resolved', uid: 'uid_existing', source: 'link' });
    expect(fixture.store.getLinkCalls).toEqual([phoneHash]);
    expect(fixture.store.fillCalls).toHaveLength(0);
    const resolvedEvent = fixture.audit.events.find((event) => event.type === 'identity.resolved');
    expect(resolvedEvent).toMatchObject({
      uid: 'uid_existing',
      phoneHash,
      outcome: 'success',
      reasonCode: null,
      actorHash: REQUESTER,
      purpose: 'sign-in',
    });
    expect(Object.hasOwn(resolvedEvent ?? {}, 'uid')).toBe(true);
    expect(fixture.logger.entries).toContainEqual({
      level: 'info',
      event: 'identity.resolved',
      fields: { challengeId: CHALLENGE_ID, source: 'link' },
    });
  });

  it('fails closed when the linked Auth user no longer exists', async () => {
    const fixture = createIdentityFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.store.seedLink(buildIdentityLink({ phoneHash, uid: 'uid_missing' }));

    const result = await resolve(fixture);

    expect(result).toEqual({ status: 'conflict', reason: 'conflict_user_missing' });
    const conflict = fixture.audit.events.find((event) => event.type === 'identity.conflict');
    expect(conflict).toMatchObject({
      outcome: 'failure',
      reasonCode: 'conflict_user_missing',
      uid: 'uid_missing',
    });
  });

  it('fails closed when the linked Auth user is disabled', async () => {
    const fixture = createIdentityFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.auth.seedUser({ uid: 'uid_disabled', phoneNumber: PHONE, disabled: true });
    fixture.store.seedLink(buildIdentityLink({ phoneHash, uid: 'uid_disabled' }));

    const result = await resolve(fixture);

    expect(result).toEqual({ status: 'conflict', reason: 'conflict_user_disabled' });
  });

  it('fails closed on phone mismatch between link user and verified phone', async () => {
    const fixture = createIdentityFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.auth.seedUser({ uid: 'uid_other', phoneNumber: OTHER_PHONE, disabled: false });
    fixture.store.seedLink(buildIdentityLink({ phoneHash, uid: 'uid_other' }));

    const result = await resolve(fixture);

    expect(result).toEqual({ status: 'conflict', reason: 'conflict_phone_mismatch' });
  });

  it('fails closed on an incomplete active link without a uid', async () => {
    const fixture = createIdentityFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.store.seedLink(buildIdentityLink({ phoneHash, uid: null }));

    const result = await resolve(fixture);

    expect(result).toEqual({ status: 'conflict', reason: 'conflict_incomplete_link' });
    const conflict = fixture.audit.events.find((event) => event.type === 'identity.conflict');
    expect(conflict).toBeDefined();
    // D-031 ID-7: omit uid entirely when it is not relevant/known.
    expect(Object.hasOwn(conflict ?? {}, 'uid')).toBe(false);
  });

  it('fails closed on a revoked link and never creates a replacement', async () => {
    const fixture = createIdentityFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.auth.seedUser({ uid: 'uid_revoked', phoneNumber: PHONE, disabled: false });
    fixture.store.seedLink(buildIdentityLink({ phoneHash, status: 'revoked', uid: 'uid_revoked' }));

    const result = await resolve(fixture);

    expect(result).toEqual({ status: 'conflict', reason: 'conflict_link_revoked' });
    expect(fixture.store.fillCalls).toHaveLength(0);
  });

  it('fails closed while a creation claim is active', async () => {
    const fixture = createIdentityFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.store.seedLink(
      buildIdentityLink({
        phoneHash,
        status: 'pending_creation',
        uid: null,
        claimId: 'claim_1',
        claimedAtMs: fixture.clock.currentTimeMs,
        claimExpiresAtMs: fixture.clock.currentTimeMs + 60_000,
      }),
    );

    const result = await resolve(fixture);

    expect(result).toEqual({ status: 'unavailable', reason: 'claim_pending' });
    expect(fixture.audit.events).toHaveLength(0);
  });

  it('fails closed on an expired claim until the creation protocol exists', async () => {
    const fixture = createIdentityFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.store.seedLink(
      buildIdentityLink({
        phoneHash,
        status: 'pending_creation',
        uid: null,
        claimId: 'claim_old',
        claimedAtMs: fixture.clock.currentTimeMs - 600_000,
        claimExpiresAtMs: fixture.clock.currentTimeMs - 480_000,
      }),
    );

    const result = await resolve(fixture);

    expect(result).toEqual({ status: 'unavailable', reason: 'claim_expired' });
  });

  it('fails closed on a corrupt pending link without a claim id', async () => {
    const fixture = createIdentityFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.store.seedLink(
      buildIdentityLink({ phoneHash, status: 'pending_creation', uid: null, claimId: null }),
    );

    const result = await resolve(fixture);

    expect(result).toEqual({ status: 'conflict', reason: 'conflict_incomplete_link' });
  });
});

describe('IdentityResolver.resolveExisting — Auth-authoritative paths', () => {
  it('resolves via Auth lookup, fills the link cache, and audits both events', async () => {
    const fixture = createIdentityFixture();
    fixture.auth.seedUser({ uid: 'uid_auth', phoneNumber: PHONE, disabled: false });

    const result = await resolve(fixture);

    expect(result).toEqual({ status: 'resolved', uid: 'uid_auth', source: 'auth' });
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    expect(fixture.store.fillCalls).toEqual([phoneHash]);
    expect(fixture.store.peekLink(phoneHash)).toMatchObject({
      status: 'active',
      uid: 'uid_auth',
      lastChallengeId: CHALLENGE_ID,
      pepperVersion: fixture.pepperVersion,
    });
    expect(fixture.audit.events.map((event) => event.type)).toEqual([
      'identity.link.filled',
      'identity.resolved',
    ]);
    for (const event of fixture.audit.events) {
      // Success events follow the engine convention: reasonCode is reserved
      // for failures; source/outcome metadata stays in logs, not reasonCode.
      expect(event.reasonCode).toBeNull();
    }
  });

  it('returns not_found without any writes or audit when Auth has no such phone', async () => {
    const fixture = createIdentityFixture();

    const result = await resolve(fixture);

    expect(result).toEqual({ status: 'not_found' });
    expect(fixture.store.fillCalls).toHaveLength(0);
    expect(fixture.audit.events).toHaveLength(0);
    expect(fixture.logger.entries).toContainEqual({
      level: 'info',
      event: 'identity.not_found',
      fields: { challengeId: CHALLENGE_ID },
    });
  });

  it('fails closed when the Auth-found user is disabled', async () => {
    const fixture = createIdentityFixture();
    fixture.auth.seedUser({ uid: 'uid_disabled', phoneNumber: PHONE, disabled: true });

    const result = await resolve(fixture);

    expect(result).toEqual({ status: 'conflict', reason: 'conflict_user_disabled' });
    expect(fixture.store.fillCalls).toHaveLength(0);
  });

  it('fails closed when the guarded link fill reports a conflict', async () => {
    const fixture = createIdentityFixture();
    fixture.auth.seedUser({ uid: 'uid_auth', phoneNumber: PHONE, disabled: false });
    fixture.store.nextFillConflict = 'conflict_link_revoked';

    const result = await resolve(fixture);

    expect(result).toEqual({ status: 'conflict', reason: 'conflict_link_revoked' });
    expect(fixture.audit.events.map((event) => event.type)).toEqual(['identity.conflict']);
  });

  it('derives its own phone hash from the supplied E.164 and cannot touch another phone record', async () => {
    const fixture = createIdentityFixture();
    fixture.auth.seedUser({ uid: 'uid_auth', phoneNumber: PHONE, disabled: false });

    await resolve(fixture, { e164: OTHER_PHONE });

    // The resolver derives its own hash from the supplied E.164; the caller is
    // responsible for the ID-9 binding. A different phone simply looks up a
    // different (empty) slot — it can never touch the challenge-bound record.
    expect(fixture.store.getLinkCalls).toEqual([hashPhone(fixture.pepper, OTHER_PHONE)]);
    expect(fixture.store.peekLink(hashPhone(fixture.pepper, PHONE))).toBeUndefined();
  });
});

describe('IdentityResolver.resolveExisting — failure handling and invariants', () => {
  it('returns unavailable when the identity store read fails', async () => {
    const fixture = createIdentityFixture();
    fixture.store.failGetLink = true;

    const result = await resolve(fixture);

    expect(result).toEqual({ status: 'unavailable', reason: 'store_unavailable' });
    expect(fixture.audit.events).toHaveLength(0);
    const unavailableLog = fixture.logger.entries.find(
      (entry) => entry.event === 'identity.unavailable',
    );
    expect(unavailableLog?.fields).toMatchObject({
      challengeId: CHALLENGE_ID,
      reason: 'store_unavailable',
    });
    expect(unavailableLog?.fields).not.toHaveProperty('phoneHash');
  });

  it('returns unavailable when Auth lookup by uid fails', async () => {
    const fixture = createIdentityFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.store.seedLink(buildIdentityLink({ phoneHash, uid: 'uid_existing' }));
    fixture.auth.failGetUser = true;

    const result = await resolve(fixture);

    expect(result).toEqual({ status: 'unavailable', reason: 'auth_unavailable' });
    expect(fixture.audit.events).toHaveLength(0);
  });

  it('returns unavailable when Auth lookup by phone fails', async () => {
    const fixture = createIdentityFixture();
    fixture.auth.failGetUserByPhoneNumber = true;

    const result = await resolve(fixture);

    expect(result).toEqual({ status: 'unavailable', reason: 'auth_unavailable' });
  });

  it('returns unavailable when the link fill throws', async () => {
    const fixture = createIdentityFixture();
    fixture.auth.seedUser({ uid: 'uid_auth', phoneNumber: PHONE, disabled: false });
    fixture.store.failFill = true;

    const result = await resolve(fixture);

    expect(result).toEqual({ status: 'unavailable', reason: 'store_unavailable' });
  });

  it('rejects non-canonical or invalid E.164 with an invariant error', async () => {
    const fixture = createIdentityFixture();

    await expect(resolve(fixture, { e164: '09876543210' })).rejects.toBeInstanceOf(
      IdentityInvariantError,
    );
    await expect(resolve(fixture, { e164: 'not-a-phone' })).rejects.toBeInstanceOf(
      IdentityInvariantError,
    );
    expect(fixture.store.getLinkCalls).toHaveLength(0);
  });

  it('keeps phone numbers and token material out of logs and audit events', async () => {
    const fixture = createIdentityFixture();
    fixture.auth.seedUser({ uid: 'uid_auth', phoneNumber: PHONE, disabled: false });
    await resolve(fixture);
    fixture.auth.seedUser({ uid: 'uid_second', phoneNumber: OTHER_PHONE, disabled: false });
    await resolve(fixture, { e164: OTHER_PHONE });

    const logs = fixture.logger.toJSON();
    const audit = fixture.audit.toJSON();
    const serialized = logs + audit;
    expect(serialized).not.toContain('9876543210');
    expect(serialized).not.toContain('9999999999');
    expect(serialized).not.toContain('+91');
    expect(serialized).not.toContain('fake-custom-token');
    // phoneHash is approved for audit correlation only; it must not leak into
    // ordinary application logs (Phase 3.1 review finding F2).
    expect(logs).not.toContain(hashPhone(fixture.pepper, PHONE));
    expect(logs).not.toContain(hashPhone(fixture.pepper, OTHER_PHONE));
    for (const event of fixture.audit.events) {
      if (event.phoneHash !== null) {
        expect(event.phoneHash).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });
});

describe('audit-failure non-interference (F1)', () => {
  function resolverWithThrowingAudit(fixture: IdentityFixture): IdentityResolver {
    return new IdentityResolver({
      store: fixture.store,
      auth: fixture.auth,
      clock: () => fixture.clock.now(),
      logger: fixture.logger,
      audit: new ThrowingAuditSink(),
      pepper: fixture.pepper,
      pepperVersion: fixture.pepperVersion,
    });
  }

  it('still resolves when every audit write fails', async () => {
    const fixture = createIdentityFixture();
    fixture.auth.seedUser({ uid: 'uid_auth', phoneNumber: PHONE, disabled: false });
    const resolver = resolverWithThrowingAudit(fixture);

    const result = await resolver.resolveExisting({
      e164: PHONE,
      challengeId: CHALLENGE_ID,
      purpose: 'sign-in',
      requesterHash: REQUESTER,
    });

    expect(result).toEqual({ status: 'resolved', uid: 'uid_auth', source: 'auth' });
    const warnings = fixture.logger.entries.filter((entry) => entry.event === 'audit.write_failed');
    expect(warnings).toHaveLength(2);
    expect(warnings.map((entry) => entry.fields?.['eventType'])).toEqual([
      'identity.link.filled',
      'identity.resolved',
    ]);
  });

  it('still returns a settled conflict when the audit write fails', async () => {
    const fixture = createIdentityFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.store.seedLink(buildIdentityLink({ phoneHash, status: 'revoked', uid: 'uid_revoked' }));
    const resolver = resolverWithThrowingAudit(fixture);

    const result = await resolver.resolveExisting({
      e164: PHONE,
      challengeId: CHALLENGE_ID,
      purpose: 'sign-in',
      requesterHash: REQUESTER,
    });

    expect(result).toEqual({ status: 'conflict', reason: 'conflict_link_revoked' });
    const warnings = fixture.logger.entries.filter((entry) => entry.event === 'audit.write_failed');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toMatchObject({ eventType: 'identity.conflict' });
  });
});
