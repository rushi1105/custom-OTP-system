# Data Model

**Status:** All collections below are **Proposed** for Phases 2–4. **Confirmed** today: no
Firestore is used at all in Phase 1, and no plaintext OTP/phone data exists anywhere in the
repository.

General rules (**Proposed**, mandatory for implementation):

- Firestore security rules deny **all** client access to every collection listed here; only
  the Admin SDK (backend) reads/writes them.
- OTP codes are never stored or logged in plaintext; only a keyed hash is stored.
- Phone numbers are never stored in plaintext; an HMAC of the E.164 number with a versioned
  pepper is stored instead.
- Every document carries server timestamps (`createdAt`, `updatedAt` as Firestore
  timestamps or ISO-8601 UTC).
- TTL policies are retention mechanisms only. Expiry and attempt limits are enforced by the
  server clock at verification time.

## 1. `otp_challenges/{challengeId}` (Proposed, Phase 2)

| Field                                  | Type                                               | Notes                                                                               |
| -------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `challengeId`                          | string                                             | Random opaque id (not sequential, not guessable)                                    |
| `phoneHash`                            | string                                             | HMAC-SHA256(pepper, E.164) hex; never the raw number                                |
| `codeHash`                             | string                                             | HMAC-SHA256(pepper, challengeSalt + code); salted per challenge                     |
| `challengeSalt`                        | string                                             | Random per-challenge salt (public is acceptable, kept together for pepper rotation) |
| `codeLength`                           | number                                             | Default 6                                                                           |
| `attempts`                             | number                                             | Incremented atomically on each verification attempt                                 |
| `maxAttempts`                          | number                                             | Default proposed 5 (policy, D-012)                                                  |
| `status`                               | `'pending' \| 'consumed' \| 'expired' \| 'locked'` | State machine per roadmap §7                                                        |
| `createdAt`, `expiresAt`, `consumedAt` | timestamp                                          | `expiresAt` default +5 minutes (D-012)                                              |
| `deliveryJobId`                        | string \| null                                     | Reference to `delivery_jobs`                                                        |
| `resendCount`                          | number                                             | For cooldown/limit policy                                                           |
| `pepperVersion`                        | number                                             | Enables pepper rotation without invalidating live challenges                        |
| `requesterHash`                        | string                                             | HMAC of salted client context (IP/device) for rate limiting; no raw values          |
| `auditRef`                             | string \| null                                     | Correlation id for audit events                                                     |

Lifecycle: created (pending) → `consumed` (success, atomic) | `expired` (TTL elapsed) |
`locked` (max attempts). Terminal states are immutable.

Suggested indexes/TTL: TTL policy on `expiresAt`; composite index `phoneHash + createdAt`
for resend policy; `status + expiresAt` for cleanup jobs.

## 2. `delivery_jobs/{jobId}` (Proposed, Phase 2/4)

| Field                         | Type                                                        | Notes                                                                                            |
| ----------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `jobId`                       | string                                                      | Unique; also used for provider idempotency                                                       |
| `challengeId`                 | string                                                      | Owning challenge                                                                                 |
| `providerId`                  | string                                                      | `mock` \| `relay` \| `msg91`-class                                                               |
| `channel`                     | `'sms'`                                                     | Matches contract                                                                                 |
| `destination`                 | string                                                      | E.164; needed at send time only — evaluate storing hashed + transient copy (D-011 open question) |
| `body`                        | string                                                      | Contains OTP; short retention; consider not persisting at all (open question D-011)              |
| `status`                      | `'pending' \| 'claimed' \| 'sent' \| 'failed' \| 'expired'` | Provider acceptance is `sent` at most, never "delivered"                                         |
| `dedupeKey`                   | string                                                      | Prevents duplicate sends for one challenge/resend window                                         |
| `claimedBy`                   | string \| null                                              | Device id (relay)                                                                                |
| `claimedAt`, `leaseExpiresAt` | timestamp                                                   | One-time claim lease                                                                             |
| `attempts`                    | number                                                      | Retry accounting                                                                                 |
| `lastError`                   | map \| null                                                 | Error code + message (no PII)                                                                    |
| `createdAt`, `updatedAt`      | timestamp                                                   |                                                                                                  |

Invariant: a job is sendable only while its challenge is `pending` and not expired; expired
jobs are `expired`, never delivered late.

## 3. `delivery_devices/{deviceId}` (Proposed, Phase 4)

| Field                                  | Type                    | Notes                                           |
| -------------------------------------- | ----------------------- | ----------------------------------------------- |
| `deviceId`                             | string                  | Assigned at enrollment                          |
| `label`                                | string                  | Human label ("relay-sim-1")                     |
| `credentialHash`                       | string                  | Hash of device credential; never the credential |
| `status`                               | `'active' \| 'revoked'` | Revocation is immediate for auth checks         |
| `enrolledAt`, `enrolledBy`             | timestamp, string       | Operator id (audited)                           |
| `revokedAt`, `revokedReason`           | timestamp, string       |                                                 |
| `lastSeenAt`, `appVersion`, `simLabel` | mixed                   | Health monitoring                               |

## 4. `identity_links/{phoneHash}` (Proposed, Phase 3)

| Field                     | Type                    | Notes                                     |
| ------------------------- | ----------------------- | ----------------------------------------- |
| `phoneHash`               | string                  | Document id: HMAC(pepper, E.164)          |
| `uid`                     | string                  | Canonical Firebase UID                    |
| `createdAt`, `verifiedAt` | timestamp               | Verified via a consumed challenge         |
| `createdBy`               | string                  | Flow id (`otp-signin`) for audit          |
| `status`                  | `'active' \| 'revoked'` | Revocation is an admin-reviewed operation |

Rules: one active link per `phoneHash`; conflict resolution never silently re-points a link
(D-013). This collection is backend-only and never referenced by clients.

## 5. `rate_limits/{bucketKey}` (Proposed, Phase 2)

| Field          | Type              | Notes                                              |
| -------------- | ----------------- | -------------------------------------------------- |
| `bucketKey`    | string            | e.g. `req:phone:<hash>:1h`, `verify:ip:<hash>:10m` |
| `windowStart`  | timestamp         | Fixed-window start                                 |
| `count`        | number            | Atomic increment per event                         |
| `blockedUntil` | timestamp \| null | Set when limit exceeded                            |

TTL on `windowStart` (short, e.g. 24h). Firestore cost/contention trade-off documented in
D-011; alternative (in-memory/Redis) kept open.

## 6. `audit_events/{eventId}` (Proposed, Phase 2)

| Field                                | Type                                             | Notes                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventId`                            | string                                           | Random id                                                                                                                                   |
| `type`                               | string                                           | `challenge.created`, `challenge.verified`, `challenge.locked`, `device.enrolled`, `device.revoked`, `provider.receipt`, `ratelimit.blocked` |
| `occurredAt`                         | timestamp                                        | Server clock                                                                                                                                |
| `actorType`                          | `'system' \| 'client' \| 'device' \| 'operator'` |                                                                                                                                             |
| `actorHash`                          | string \| null                                   | Hashed identifier; no raw phone/IP                                                                                                          |
| `challengeId` / `jobId` / `deviceId` | string \| null                                   | Correlation                                                                                                                                 |
| `outcome`                            | `'success' \| 'failure' \`                       |                                                                                                                                             |
| `reasonCode`                         | string \| null                                   | Stable machine-readable reason                                                                                                              |
| `metadata`                           | map                                              | Must never contain codes, tokens, or raw phone numbers                                                                                      |

Retention: proposed 90 days (policy TBD, compliance item 5). TTL policy on `occurredAt`.

## 7. Deliberately absent data

- No plaintext OTPs, ever.
- No raw phone numbers in audit/log collections.
- No Firebase credentials in any collection.
- No client-readable collections: rules will deny everything; the app talks only through the
  HTTP API and Firebase Auth.

## 8. Open questions (tracked in D-011/D-012/D-013)

1. Whether `delivery_jobs.body` (the OTP) should be persisted at all, or passed transiently
   to the provider and never stored.
2. Whether challenge attempt counters can live in the challenge doc under Firestore
   transaction contention at pilot volume, or need a separate counter strategy.
3. Retention windows for each collection (compliance-driven).
4. Whether `identity_links` needs a secondary index collection for UID → phone-hash reverse
   lookup (only if a future, approved operation requires it).
