import { describe, expect, it } from 'vitest';

import { IdentityCreationService } from '../../functions/src/identity/creation';
import {
  AuthInvalidPhoneError,
  AuthPhoneAlreadyExistsError,
  AuthUnavailableError,
  IdentityInvariantError,
} from '../../functions/src/identity/errors';
import { hashPhone } from '../../functions/src/otp/hashing';
import { createCreationFixture, type CreationFixture } from '../helpers/creation-fixture';
import { buildIdentityLink, ThrowingAuditSink } from '../helpers/identity-fakes';

const PHONE = '+919876543210';
const CHALLENGE_ID = 'c_AAAAAAAAAAAAAAAAAAAAAA';
const REQUESTER = 'requester-1';
const INPUT = {
  e164: PHONE,
  challengeId: CHALLENGE_ID,
  purpose: 'sign-in',
  requesterHash: REQUESTER,
};

function ensure(
  fixture: CreationFixture,
  overrides: Partial<typeof INPUT> = {},
): ReturnType<IdentityCreationService['ensureIdentity']> {
  return fixture.creation.ensureIdentity({ ...INPUT, ...overrides });
}

function auditTypes(fixture: CreationFixture): string[] {
  return fixture.audit.events.map((event) => event.type);
}

function serviceWithAudit(
  fixture: CreationFixture,
  audit: ThrowingAuditSink,
): IdentityCreationService {
  return new IdentityCreationService({
    resolver: fixture.resolver,
    store: fixture.store,
    auth: fixture.auth,
    clock: () => fixture.clock.now(),
    logger: fixture.logger,
    audit,
    pepper: fixture.pepper,
    pepperVersion: fixture.pepperVersion,
    sleep: async (milliseconds) => {
      fixture.sleepCalls.push(milliseconds);
    },
  });
}

describe('IdentityCreationService — normal outcomes', () => {
  it('resolves an existing authoritative user without creating another', async () => {
    const fixture = createCreationFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.auth.seedUser({ uid: 'uid_existing', phoneNumber: PHONE, disabled: false });
    fixture.store.seedLink(buildIdentityLink({ phoneHash, uid: 'uid_existing' }));

    const result = await ensure(fixture);

    expect(result).toEqual({ status: 'resolved', uid: 'uid_existing', source: 'link' });
    expect(fixture.auth.createCalls).toHaveLength(0);
    expect(fixture.store.acquireClaimCalls).toHaveLength(0);
  });

  it('creates a user, finalizes the link, and audits identity.created', async () => {
    const fixture = createCreationFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);

    const result = await ensure(fixture);

    expect(result.status).toBe('created');
    if (result.status !== 'created') {
      return;
    }
    expect(fixture.auth.createCalls).toEqual([PHONE]);
    expect(await fixture.auth.getUser(result.uid)).toMatchObject({
      uid: result.uid,
      phoneNumber: PHONE,
    });
    expect(fixture.store.peekLink(phoneHash)).toMatchObject({
      status: 'active',
      uid: result.uid,
      claimId: null,
      lastChallengeId: CHALLENGE_ID,
    });
    const createdEvent = fixture.audit.events.find((event) => event.type === 'identity.created');
    expect(createdEvent).toMatchObject({
      uid: result.uid,
      phoneHash,
      outcome: 'success',
      reasonCode: null,
      actorHash: REQUESTER,
    });
    const serialized = fixture.logger.toJSON() + fixture.audit.toJSON();
    expect(serialized).not.toContain('9876543210');
    expect(serialized).not.toContain('+91');
  });

  it('takes over an expired claim and audits the expiry', async () => {
    const fixture = createCreationFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.store.seedLink(
      buildIdentityLink({
        phoneHash,
        status: 'pending_creation',
        uid: null,
        claimId: 'claim-old',
        claimedAtMs: fixture.clock.currentTimeMs - 240_000,
        claimExpiresAtMs: fixture.clock.currentTimeMs - 120_000,
      }),
    );

    const result = await ensure(fixture);

    expect(result.status).toBe('created');
    if (result.status !== 'created') {
      return;
    }
    expect(fixture.store.acquireClaimCalls).toHaveLength(1);
    expect(auditTypes(fixture)).toContain('identity.claim.expired');
    expect(auditTypes(fixture)).toContain('identity.created');
    const expiredEvent = fixture.audit.events.find(
      (event) => event.type === 'identity.claim.expired',
    );
    expect(expiredEvent).toBeDefined();
    expect(Object.hasOwn(expiredEvent ?? {}, 'uid')).toBe(false);
    expect(fixture.store.peekLink(phoneHash)).toMatchObject({
      status: 'active',
      uid: result.uid,
    });
    expect(fixture.auth.createCalls).toHaveLength(1);
  });

  it('recovers after an expired claim when the Auth user already exists (crash after create)', async () => {
    const fixture = createCreationFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.auth.seedUser({ uid: 'uid_existing', phoneNumber: PHONE, disabled: false });
    fixture.store.seedLink(
      buildIdentityLink({
        phoneHash,
        status: 'pending_creation',
        uid: null,
        claimId: 'claim-old',
        claimedAtMs: fixture.clock.currentTimeMs - 240_000,
        claimExpiresAtMs: fixture.clock.currentTimeMs - 120_000,
      }),
    );

    const result = await ensure(fixture);

    expect(result).toEqual({ status: 'recovered', uid: 'uid_existing' });
    expect(fixture.auth.createCalls).toHaveLength(0);
    expect(fixture.store.peekLink(phoneHash)).toMatchObject({
      status: 'active',
      uid: 'uid_existing',
    });
    expect(auditTypes(fixture)).toContain('identity.resolved');
  });

  it('fails closed without acquiring when the expired-claim pre-check cannot reach Auth', async () => {
    const fixture = createCreationFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.store.seedLink(
      buildIdentityLink({
        phoneHash,
        status: 'pending_creation',
        uid: null,
        claimId: 'claim-old',
        claimedAtMs: fixture.clock.currentTimeMs - 240_000,
        claimExpiresAtMs: fixture.clock.currentTimeMs - 120_000,
      }),
    );
    fixture.auth.failGetUserByPhoneNumber = true;

    const result = await ensure(fixture);

    expect(result).toEqual({ status: 'unavailable', reason: 'auth_unavailable' });
    expect(fixture.store.acquireClaimCalls).toHaveLength(0);
    expect(fixture.store.releaseClaimCalls).toHaveLength(0);
    expect(fixture.auth.createCalls).toHaveLength(0);
    expect(fixture.store.peekLink(phoneHash)).toMatchObject({
      status: 'pending_creation',
      claimId: 'claim-old',
    });
  });

  it('fails closed without acquiring when the expired-claim pre-check finds a disabled user', async () => {
    const fixture = createCreationFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.auth.seedUser({ uid: 'uid_disabled', phoneNumber: PHONE, disabled: true });
    fixture.store.seedLink(
      buildIdentityLink({
        phoneHash,
        status: 'pending_creation',
        uid: null,
        claimId: 'claim-old',
        claimedAtMs: fixture.clock.currentTimeMs - 240_000,
        claimExpiresAtMs: fixture.clock.currentTimeMs - 120_000,
      }),
    );

    const result = await ensure(fixture);

    expect(result).toEqual({ status: 'conflict', reason: 'conflict_user_disabled' });
    expect(fixture.store.acquireClaimCalls).toHaveLength(0);
    expect(fixture.store.releaseClaimCalls).toHaveLength(0);
    expect(fixture.auth.createCalls).toHaveLength(0);
    expect(fixture.store.peekLink(phoneHash)).toMatchObject({
      status: 'pending_creation',
      claimId: 'claim-old',
    });
    const conflict = fixture.audit.events.find((event) => event.type === 'identity.conflict');
    expect(conflict).toMatchObject({
      reasonCode: 'conflict_user_disabled',
      uid: 'uid_disabled',
    });
  });
});

describe('IdentityCreationService — claims and concurrency', () => {
  it('retries an unexpired claim exactly three times with the approved delay', async () => {
    const fixture = createCreationFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.store.seedLink(
      buildIdentityLink({
        phoneHash,
        status: 'pending_creation',
        uid: null,
        claimId: 'other-claim',
        claimedAtMs: fixture.clock.currentTimeMs,
        claimExpiresAtMs: fixture.clock.currentTimeMs + 60_000,
      }),
    );

    const result = await ensure(fixture);

    expect(result).toEqual({ status: 'unavailable', reason: 'claim_pending' });
    expect(fixture.sleepCalls).toEqual([150, 150]);
    expect(fixture.store.acquireClaimCalls).toHaveLength(0);
    expect(fixture.auth.createCalls).toHaveLength(0);
    expect((await fixture.store.getLink(phoneHash))?.status).toBe('pending_creation');
  });

  it('retries when claim acquisition reports another claimant in progress', async () => {
    const fixture = createCreationFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.store.nextAcquireResults.push(
      { outcome: 'in_progress' },
      { outcome: 'in_progress' },
      { outcome: 'in_progress' },
    );

    const result = await ensure(fixture);

    expect(result).toEqual({ status: 'unavailable', reason: 'claim_pending' });
    expect(fixture.sleepCalls).toEqual([150, 150]);
    expect(fixture.store.acquireClaimCalls).toHaveLength(3);
    expect(fixture.store.releaseClaimCalls).toHaveLength(0);
    expect(fixture.auth.createCalls).toHaveLength(0);
    expect(fixture.store.peekLink(phoneHash)).toBeUndefined();
  });

  it('recovers when claim acquisition reports the link became active during the race', async () => {
    const fixture = createCreationFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.store.nextAcquireResults.push({ outcome: 'active', uid: 'uid_winner' });
    fixture.store.onAcquireResult = () => {
      fixture.auth.seedUser({ uid: 'uid_winner', phoneNumber: PHONE, disabled: false });
      fixture.store.seedLink(
        buildIdentityLink({
          phoneHash,
          status: 'active',
          uid: 'uid_winner',
          lastChallengeId: CHALLENGE_ID,
        }),
      );
    };

    const result = await ensure(fixture);

    expect(result).toEqual({ status: 'resolved', uid: 'uid_winner', source: 'link' });
    expect(fixture.sleepCalls).toEqual([150]);
    expect(fixture.store.acquireClaimCalls).toHaveLength(1);
    expect(fixture.auth.createCalls).toHaveLength(0);
    expect(fixture.store.peekLink(phoneHash)).toMatchObject({
      status: 'active',
      uid: 'uid_winner',
    });
  });

  it('does not overwrite a revoked link', async () => {
    const fixture = createCreationFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.store.seedLink(buildIdentityLink({ phoneHash, status: 'revoked', uid: 'uid_revoked' }));

    const result = await ensure(fixture);

    expect(result).toEqual({ status: 'conflict', reason: 'conflict_link_revoked' });
    expect(fixture.store.acquireClaimCalls).toHaveLength(0);
    expect(fixture.auth.createCalls).toHaveLength(0);
    expect(fixture.store.peekLink(phoneHash)).toMatchObject({
      status: 'revoked',
      uid: 'uid_revoked',
    });
  });

  it('creates at most one Auth user under concurrent first-time sign-ins', async () => {
    const fixture = createCreationFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);

    const results = await Promise.all(Array.from({ length: 5 }, () => ensure(fixture)));

    expect(fixture.auth.createCalls).toHaveLength(1);
    expect(fixture.auth.userCount).toBe(1);
    const uids = new Set<string>();
    let successes = 0;
    for (const result of results) {
      if ('uid' in result) {
        uids.add(result.uid);
        successes += 1;
      } else {
        expect(result).toEqual({ status: 'unavailable', reason: 'claim_pending' });
      }
    }
    expect(successes).toBeGreaterThan(0);
    expect(uids.size).toBe(1);
    const [uid] = [...uids];
    expect(fixture.store.peekLink(phoneHash)).toMatchObject({
      status: 'active',
      uid,
      claimId: null,
    });
    const created = await fixture.auth.getUserByPhoneNumber(PHONE);
    expect(created?.uid).toBe(uid);
    expect(auditTypes(fixture).filter((type) => type === 'identity.created')).toHaveLength(1);
  });

  it('releases only the claim owned by the failed attempt', async () => {
    const fixture = createCreationFixture();
    fixture.auth.nextCreateError = new AuthUnavailableError('auth down', 'auth/internal-error');

    await ensure(fixture);

    expect(fixture.store.releaseClaimCalls).toHaveLength(1);
    expect(fixture.store.releaseClaimCalls[0]?.claimId).toBe(
      fixture.store.acquireClaimCalls[0]?.claimId,
    );
  });
});

describe('IdentityCreationService — duplicate phones and recovery', () => {
  it('recovers a duplicate-phone race by finalizing to the authoritative user', async () => {
    const fixture = createCreationFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.auth.lookupByPhoneQueue = [
      null,
      null,
      { uid: 'uid_winner', phoneNumber: PHONE, disabled: false },
    ];
    fixture.auth.nextCreateError = new AuthPhoneAlreadyExistsError(
      'phone already registered',
      'auth/phone-number-already-exists',
    );

    const result = await ensure(fixture);

    expect(result).toEqual({ status: 'recovered', uid: 'uid_winner' });
    expect(fixture.auth.createCalls).toHaveLength(1);
    expect(fixture.store.peekLink(phoneHash)).toMatchObject({
      status: 'active',
      uid: 'uid_winner',
    });
    expect(auditTypes(fixture)).toContain('identity.resolved');
  });

  it('fails closed on an unresolved duplicate-phone error and releases the claim', async () => {
    const fixture = createCreationFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.auth.lookupByPhoneQueue = [null, null, null];
    fixture.auth.nextCreateError = new AuthPhoneAlreadyExistsError(
      'phone already registered',
      'auth/phone-number-already-exists',
    );

    const result = await ensure(fixture);

    expect(result).toEqual({
      status: 'conflict',
      reason: 'phone_already_exists_unresolved',
    });
    expect(fixture.auth.createCalls).toHaveLength(1);
    expect(fixture.store.peekLink(phoneHash)).toBeUndefined();
    const conflict = fixture.audit.events.find((event) => event.type === 'identity.conflict');
    expect(conflict).toBeDefined();
    expect(Object.hasOwn(conflict ?? {}, 'uid')).toBe(false);
  });

  it('fails closed and releases the claim when duplicate-phone recovery cannot reach Auth', async () => {
    const fixture = createCreationFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.auth.lookupByPhoneQueue = [
      null,
      null,
      new AuthUnavailableError('auth down', 'auth/internal-error'),
    ];
    fixture.auth.nextCreateError = new AuthPhoneAlreadyExistsError(
      'phone already registered',
      'auth/phone-number-already-exists',
    );

    const result = await ensure(fixture);

    expect(result).toEqual({ status: 'unavailable', reason: 'auth_unavailable' });
    expect(fixture.auth.createCalls).toHaveLength(1);
    expect(fixture.store.releaseClaimCalls).toHaveLength(1);
    expect(fixture.store.releaseClaimCalls[0]?.claimId).toBe(
      fixture.store.acquireClaimCalls[0]?.claimId,
    );
    expect(fixture.store.peekLink(phoneHash)).toBeUndefined();
    expect(fixture.auth.userCount).toBe(0);
  });

  it('fails closed when duplicate-phone recovery finds a disabled user', async () => {
    const fixture = createCreationFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.auth.lookupByPhoneQueue = [
      null,
      null,
      { uid: 'uid_disabled', phoneNumber: PHONE, disabled: true },
    ];
    fixture.auth.nextCreateError = new AuthPhoneAlreadyExistsError(
      'phone already registered',
      'auth/phone-number-already-exists',
    );

    const result = await ensure(fixture);

    expect(result).toEqual({ status: 'conflict', reason: 'conflict_user_disabled' });
    expect(fixture.auth.createCalls).toHaveLength(1);
    expect(fixture.store.releaseClaimCalls).toHaveLength(1);
    expect(fixture.store.peekLink(phoneHash)).toBeUndefined();
    const conflict = fixture.audit.events.find((event) => event.type === 'identity.conflict');
    expect(conflict).toMatchObject({
      reasonCode: 'conflict_user_disabled',
      uid: 'uid_disabled',
    });
  });

  it('recovers after finalization failure without creating a second user', async () => {
    const fixture = createCreationFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.store.failFinalizeClaim = true;

    const first = await ensure(fixture);

    expect(first).toEqual({ status: 'unavailable', reason: 'store_unavailable' });
    expect(fixture.auth.createCalls).toHaveLength(1);
    expect(auditTypes(fixture)).toContain('identity.created');
    expect(fixture.store.peekLink(phoneHash)).toBeUndefined();

    const created = await fixture.auth.getUserByPhoneNumber(PHONE);
    expect(created).not.toBeNull();
    fixture.store.failFinalizeClaim = false;

    const second = await ensure(fixture);

    expect(second).toEqual({ status: 'resolved', uid: created?.uid, source: 'auth' });
    expect(fixture.auth.createCalls).toHaveLength(1);
  });

  it('never deletes the created user when claim ownership is lost after creation', async () => {
    const fixture = createCreationFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.store.nextFinalizeResult = { outcome: 'claim_lost' };

    const result = await ensure(fixture);

    expect(result).toEqual({ status: 'unavailable', reason: 'claim_pending' });
    expect(fixture.auth.createCalls).toHaveLength(1);
    const created = await fixture.auth.getUserByPhoneNumber(PHONE);
    expect(created).not.toBeNull();
    expect(fixture.store.peekLink(phoneHash)?.status).toBe('pending_creation');
  });

  it('recovers when another claimant finalized the link after our finalization lost ownership', async () => {
    const fixture = createCreationFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.store.nextFinalizeResult = { outcome: 'claim_lost' };
    fixture.store.onNextFinalizeResult = () => {
      fixture.auth.seedUser({ uid: 'uid_winner', phoneNumber: PHONE, disabled: false });
      fixture.store.seedLink(
        buildIdentityLink({
          phoneHash,
          status: 'active',
          uid: 'uid_winner',
          lastChallengeId: CHALLENGE_ID,
        }),
      );
    };

    const result = await ensure(fixture);

    expect(result).toEqual({ status: 'resolved', uid: 'uid_winner', source: 'link' });
    expect(fixture.auth.createCalls).toHaveLength(1);
    expect(fixture.auth.userCount).toBe(2);
    expect(fixture.store.peekLink(phoneHash)).toMatchObject({
      status: 'active',
      uid: 'uid_winner',
    });
    expect(auditTypes(fixture)).toContain('identity.resolved');
  });

  it('fails closed on a disabled authoritative user found after the claim', async () => {
    const fixture = createCreationFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.auth.lookupByPhoneQueue = [
      null,
      { uid: 'uid_disabled', phoneNumber: PHONE, disabled: true },
    ];

    const result = await ensure(fixture);

    expect(result).toEqual({ status: 'conflict', reason: 'conflict_user_disabled' });
    expect(fixture.auth.createCalls).toHaveLength(0);
    expect(fixture.store.peekLink(phoneHash)).toBeUndefined();
    const conflict = fixture.audit.events.find((event) => event.type === 'identity.conflict');
    expect(conflict).toMatchObject({ reasonCode: 'conflict_user_disabled', uid: 'uid_disabled' });
  });

  it('fails closed when Auth rejects the phone during creation', async () => {
    const fixture = createCreationFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.auth.nextCreateError = new AuthInvalidPhoneError(
      'invalid phone',
      'auth/invalid-phone-number',
    );

    const result = await ensure(fixture);

    expect(result).toEqual({ status: 'unavailable', reason: 'auth_unavailable' });
    expect(fixture.auth.createCalls).toHaveLength(1);
    expect(fixture.store.releaseClaimCalls).toHaveLength(1);
    expect(fixture.store.peekLink(phoneHash)).toBeUndefined();
    expect(fixture.auth.userCount).toBe(0);
    expect(auditTypes(fixture)).not.toContain('identity.conflict');
  });

  it('does not mistake a transient lookup failure for user-not-found', async () => {
    const fixture = createCreationFixture();
    fixture.auth.failGetUserByPhoneNumber = true;

    const result = await ensure(fixture);

    expect(result).toEqual({ status: 'unavailable', reason: 'auth_unavailable' });
    expect(fixture.store.acquireClaimCalls).toHaveLength(0);
    expect(fixture.auth.createCalls).toHaveLength(0);
  });

  it('fails closed when claim acquisition fails', async () => {
    const fixture = createCreationFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.store.failAcquireClaim = true;

    const result = await ensure(fixture);

    expect(result).toEqual({ status: 'unavailable', reason: 'store_unavailable' });
    expect(fixture.store.acquireClaimCalls).toHaveLength(1);
    expect(fixture.store.releaseClaimCalls).toHaveLength(0);
    expect(fixture.store.peekLink(phoneHash)).toBeUndefined();
    expect(fixture.auth.createCalls).toHaveLength(0);
  });

  it('fails closed on a finalization conflict without deleting the created user', async () => {
    const fixture = createCreationFixture();
    fixture.store.nextFinalizeResult = {
      outcome: 'blocked',
      reason: 'conflict_uid_mismatch',
    };

    const result = await ensure(fixture);

    expect(result).toEqual({ status: 'conflict', reason: 'conflict_uid_mismatch' });
    expect(fixture.auth.createCalls).toHaveLength(1);
    const created = await fixture.auth.getUserByPhoneNumber(PHONE);
    expect(created).not.toBeNull();
  });
});

describe('IdentityCreationService — failures, audit, and privacy', () => {
  it('releases the claim on Auth creation failure but keeps the primary result', async () => {
    const fixture = createCreationFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.store.failReleaseClaim = true;
    fixture.auth.nextCreateError = new AuthUnavailableError('auth down', 'auth/internal-error');

    const result = await ensure(fixture);

    expect(result).toEqual({ status: 'unavailable', reason: 'auth_unavailable' });
    expect(fixture.logger.entries).toContainEqual({
      level: 'warn',
      event: 'identity.claim.release_failed',
      fields: { challengeId: CHALLENGE_ID },
    });
    expect(fixture.store.peekLink(phoneHash)?.status).toBe('pending_creation');
  });

  it('releases the claim and fails closed when Auth becomes unavailable immediately after the claim', async () => {
    const fixture = createCreationFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.auth.lookupByPhoneQueue = [
      null,
      new AuthUnavailableError('auth down', 'auth/internal-error'),
    ];

    const result = await ensure(fixture);

    expect(result).toEqual({ status: 'unavailable', reason: 'auth_unavailable' });
    expect(fixture.store.acquireClaimCalls).toHaveLength(1);
    expect(fixture.store.releaseClaimCalls).toHaveLength(1);
    expect(fixture.store.releaseClaimCalls[0]?.claimId).toBe(
      fixture.store.acquireClaimCalls[0]?.claimId,
    );
    expect(fixture.store.peekLink(phoneHash)).toBeUndefined();
    expect(fixture.auth.createCalls).toHaveLength(0);
    expect(fixture.auth.userCount).toBe(0);
  });

  it('releases an owned claim when finalization fails during existing-user recovery', async () => {
    const fixture = createCreationFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.auth.seedUser({ uid: 'uid_existing', phoneNumber: PHONE, disabled: false });
    fixture.store.seedLink(
      buildIdentityLink({
        phoneHash,
        status: 'pending_creation',
        uid: null,
        claimId: 'claim-old',
        claimedAtMs: fixture.clock.currentTimeMs - 240_000,
        claimExpiresAtMs: fixture.clock.currentTimeMs - 120_000,
      }),
    );
    fixture.store.failFinalizeClaim = true;

    const result = await ensure(fixture);

    expect(result).toEqual({ status: 'unavailable', reason: 'store_unavailable' });
    expect(fixture.auth.createCalls).toHaveLength(0);
    expect(fixture.store.finalizeClaimCalls).toHaveLength(1);
    expect(fixture.store.finalizeClaimCalls[0]?.uid).toBe('uid_existing');
    expect(fixture.store.releaseClaimCalls).toHaveLength(1);
    expect(fixture.store.releaseClaimCalls[0]?.claimId).toBe(
      fixture.store.acquireClaimCalls[0]?.claimId,
    );
    expect(fixture.store.peekLink(phoneHash)).toBeUndefined();
    expect(fixture.auth.userCount).toBe(1);
  });

  it('keeps the created user when claim release also fails after a finalization failure', async () => {
    const fixture = createCreationFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    fixture.store.failFinalizeClaim = true;
    fixture.store.failReleaseClaim = true;

    const result = await ensure(fixture);

    expect(result).toEqual({ status: 'unavailable', reason: 'store_unavailable' });
    expect(fixture.auth.createCalls).toHaveLength(1);
    expect(fixture.auth.userCount).toBe(1);
    expect(fixture.store.releaseClaimCalls).toHaveLength(1);
    expect(fixture.logger.entries).toContainEqual({
      level: 'warn',
      event: 'identity.claim.release_failed',
      fields: { challengeId: CHALLENGE_ID },
    });
    expect(fixture.store.peekLink(phoneHash)).toMatchObject({
      status: 'pending_creation',
      uid: null,
    });
    const created = await fixture.auth.getUserByPhoneNumber(PHONE);
    expect(created).not.toBeNull();
  });

  it('continues expired-claim takeover when the expiry audit fails', async () => {
    const fixture = createCreationFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    const audit = new ThrowingAuditSink();
    const service = serviceWithAudit(fixture, audit);
    fixture.store.seedLink(
      buildIdentityLink({
        phoneHash,
        status: 'pending_creation',
        uid: null,
        claimId: 'claim-old',
        claimedAtMs: fixture.clock.currentTimeMs - 240_000,
        claimExpiresAtMs: fixture.clock.currentTimeMs - 120_000,
      }),
    );

    const result = await service.ensureIdentity(INPUT);

    expect(result.status).toBe('created');
    expect(fixture.auth.createCalls).toHaveLength(1);
    expect(fixture.auth.userCount).toBe(1);
    expect(fixture.store.peekLink(phoneHash)).toMatchObject({ status: 'active' });
    expect(audit.attempts.map((event) => event.type)).toContain('identity.claim.expired');
    const warnings = fixture.logger.entries.filter((entry) => entry.event === 'audit.write_failed');
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('continues existing-user recovery when the resolved audit fails', async () => {
    const fixture = createCreationFixture();
    const phoneHash = hashPhone(fixture.pepper, PHONE);
    const audit = new ThrowingAuditSink();
    const service = serviceWithAudit(fixture, audit);
    fixture.auth.seedUser({ uid: 'uid_existing', phoneNumber: PHONE, disabled: false });
    fixture.store.seedLink(
      buildIdentityLink({
        phoneHash,
        status: 'pending_creation',
        uid: null,
        claimId: 'claim-old',
        claimedAtMs: fixture.clock.currentTimeMs - 240_000,
        claimExpiresAtMs: fixture.clock.currentTimeMs - 120_000,
      }),
    );

    const result = await service.ensureIdentity(INPUT);

    expect(result).toEqual({ status: 'recovered', uid: 'uid_existing' });
    expect(fixture.auth.createCalls).toHaveLength(0);
    expect(fixture.auth.userCount).toBe(1);
    expect(fixture.store.peekLink(phoneHash)).toMatchObject({
      status: 'active',
      uid: 'uid_existing',
    });
    expect(audit.attempts.map((event) => event.type)).toContain('identity.resolved');
    const warnings = fixture.logger.entries.filter((entry) => entry.event === 'audit.write_failed');
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps identity results correct when the audit sink always fails', async () => {
    const fixture = createCreationFixture();
    const service = new IdentityCreationService({
      resolver: fixture.resolver,
      store: fixture.store,
      auth: fixture.auth,
      clock: () => fixture.clock.now(),
      logger: fixture.logger,
      audit: new ThrowingAuditSink(),
      pepper: fixture.pepper,
      pepperVersion: fixture.pepperVersion,
      sleep: async () => undefined,
    });

    const result = await service.ensureIdentity(INPUT);

    expect(result.status).toBe('created');
    expect(fixture.auth.createCalls).toHaveLength(1);
    const warnings = fixture.logger.entries.filter((entry) => entry.event === 'audit.write_failed');
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('rejects non-canonical phones and non-sign-in purposes before touching state', async () => {
    const fixture = createCreationFixture();

    await expect(ensure(fixture, { e164: '09876543210' })).rejects.toBeInstanceOf(
      IdentityInvariantError,
    );
    await expect(ensure(fixture, { purpose: 'phone-verification' })).rejects.toBeInstanceOf(
      IdentityInvariantError,
    );
    expect(fixture.store.acquireClaimCalls).toHaveLength(0);
    expect(fixture.auth.createCalls).toHaveLength(0);
  });

  it('never writes raw phones or tokens into logs or audit events', async () => {
    const fixture = createCreationFixture();
    fixture.auth.lookupByPhoneQueue = [null, null, null];
    fixture.auth.nextCreateError = new AuthPhoneAlreadyExistsError(
      'phone already registered',
      'auth/phone-number-already-exists',
    );

    await ensure(fixture);

    const serialized = fixture.logger.toJSON() + fixture.audit.toJSON();
    expect(serialized).not.toContain('9876543210');
    expect(serialized).not.toContain('+91');
    expect(serialized).not.toContain('fake-custom-token');
    for (const event of fixture.audit.events) {
      if (event.phoneHash !== null) {
        expect(event.phoneHash).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });
});
