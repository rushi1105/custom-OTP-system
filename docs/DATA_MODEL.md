# Data Model

**Status: Implemented in Phase 2** for the collections below (code + unit tests + Firestore
emulator integration tests). Firestore access rules are implemented and tested
(`firestore.rules`, `tests/security/firestore-rules.test.ts`).

General rules (enforced by implementation):

- Firestore security rules deny **all** client access to every collection; only the Admin
  SDK (backend) reads/writes them. Verified by emulator rules tests for both
  unauthenticated and authenticated contexts.
- OTP codes are never stored or logged in plaintext; only a keyed HMAC is stored.
- Phone numbers are never stored in plaintext; only `HMAC-SHA256(pepper, "phone:v1:" + E.164)`
  is stored. Verified by tests asserting persisted documents and logs contain no phone
  digits or codes.
- Delivery job documents deliberately do **not** persist the message body or destination
  (see "Not stored" below and D-019).
- Every document carries a numeric `ttlAtMs` field; the Firestore adapter mirrors it to a
  `ttlAt` timestamp for future Firestore TTL policies (D-023). TTL policies are an
  operations task and are **not** configured yet; cleanup never gates correctness because
  expiry is always enforced by the engine clock.

## 1. `otp_challenges/{challengeId}`

| Field                                | Type                                                         | Notes                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `challengeId`                        | string                                                       | `c_` + 128-bit base64url (CSPRNG); document id                                                         |
| `purpose`                            | `'sign-in' \| 'phone-verification'`                          | Bound into the code hash; verify must match                                                            |
| `phoneHash`                          | string                                                       | HMAC hex, 64 chars; never the raw number                                                               |
| `pepperVersion`                      | number                                                       | Stored so pepper rotation is detectable; rotated peppers invalidate live challenges (max 5 min impact) |
| `codeHash`                           | string                                                       | `HMAC-SHA256(pepper, "code:v1:" + salt + ":" + purpose + ":" + code)` hex                              |
| `salt`                               | string                                                       | Random 128-bit base64url per challenge                                                                 |
| `codeLength`                         | number                                                       | 6 (policy constant)                                                                                    |
| `attempts`                           | number                                                       | Incremented atomically per failed verification                                                         |
| `maxAttempts`                        | number                                                       | 5 (policy constant)                                                                                    |
| `status`                             | `'pending' \| 'consumed' \| 'expired' \| 'locked' \| 'void'` | State machine per roadmap §7                                                                           |
| `createdAt`, `expiresAt`             | ISO-8601                                                     | TTL 300 s (policy constant)                                                                            |
| `consumedAt`, `lockedAt`, `voidedAt` | ISO-8601 (optional)                                          | Terminal transition timestamps                                                                         |
| `voidReason`                         | `'superseded' \| 'delivery_rejected' \| 'delivery_failed'`   | Present when voided                                                                                    |
| `deliveryJobId`                      | string                                                       | Correlated delivery job                                                                                |
| `requesterHash`                      | string                                                       | HMAC of client context for audit correlation                                                           |
| `ttlAtMs` / `ttlAt`                  | number / Timestamp                                           | Retention mirror (expiry + 24 h default)                                                               |

## 2. `otp_phone_state/{phoneHash}`

| Field                                        | Type               | Notes                                                                                                     |
| -------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------- |
| `phoneHash`                                  | string             | Document id                                                                                               |
| `activeChallengeId`                          | string \| null     | Latest live challenge for this phone; resend voids a still-pending previous challenge                     |
| `cooldownUntilMs`                            | number \| null     | Resend cooldown (60 s default); cleared when a delivery failure voids the challenge so the user can retry |
| `requestWindowStartMs`, `requestWindowCount` | number             | Fixed window: 3 requests / 15 min per phone                                                               |
| `lastRequestedAtMs`                          | number             | Audit/ops visibility                                                                                      |
| `ttlAtMs` / `ttlAt`                          | number / Timestamp | Retention mirror (24 h)                                                                                   |

## 3. `requester_state/{requesterHash}`

| Field                                        | Type               | Notes                                                          |
| -------------------------------------------- | ------------------ | -------------------------------------------------------------- |
| `requesterHash`                              | string             | Document id; HMAC of client IP + User-Agent (never raw values) |
| `requestWindowStartMs`, `requestWindowCount` | number             | Fixed window: 10 requests / 10 min per requester               |
| `verifyWindowStartMs`, `verifyWindowCount`   | number             | Fixed window: 20 verifications / 10 min per requester          |
| `ttlAtMs` / `ttlAt`                          | number / Timestamp | Retention mirror (24 h)                                        |

## 4. `rate_limits/{bucketKey}`

Global request buckets, one document per minute: id `req-global-<windowStartMs>`.

| Field               | Type               | Notes                                    |
| ------------------- | ------------------ | ---------------------------------------- |
| `bucketKey`         | string             | Document id                              |
| `windowStartMs`     | number             | Minute-aligned window start              |
| `count`             | number             | 60 requests / minute global default      |
| `ttlAtMs` / `ttlAt` | number / Timestamp | Retention mirror (1 h past window start) |

## 5. `delivery_jobs/{jobId}`

| Field                       | Type                                                | Notes                                                          |
| --------------------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| `jobId`                     | string                                              | `j_` + 128-bit base64url; idempotency key for providers        |
| `challengeId`               | string                                              | Owning challenge                                               |
| `providerId`                | string                                              | `mock` in Phase 2 (from the dispatcher, not client input)      |
| `channel`                   | `'sms'`                                             | Contract channel                                               |
| `status`                    | `'pending' \| 'accepted' \| 'rejected' \| 'failed'` | `accepted` = provider accepted for delivery, never "delivered" |
| `dedupeKey`                 | string                                              | Challenge id; one job per challenge                            |
| `attempts`                  | number                                              | Dispatch attempts (0 or 1 in Phase 2; no auto-retry)           |
| `createdAt`, `updatedAt`    | ISO-8601                                            |                                                                |
| `receipt.providerMessageId` | string (optional)                                   | Provider-assigned id                                           |
| `receipt.reportedAt`        | ISO-8601                                            | Provider receipt time                                          |
| `receipt.errorCode`         | contract error code (optional)                      | e.g. `PROVIDER_UNAVAILABLE`                                    |
| `receipt.retryable`         | boolean (optional)                                  | Provider-declared retryability                                 |
| `ttlAtMs` / `ttlAt`         | number / Timestamp                                  | Retention mirror                                               |

## 6. `audit_events/{eventId}`

| Field                                          | Type                     | Notes                                                                                                                                                                                                         |
| ---------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventId`                                      | string                   | `a_` + 96-bit base64url                                                                                                                                                                                       |
| `type`                                         | string                   | `otp.request.created`, `otp.request.blocked`, `otp.request.delivery_failed`, `otp.verification.succeeded`, `otp.verification.failed`, `otp.challenge.locked`, `otp.challenge.voided`, `otp.challenge.expired` |
| `occurredAt`                                   | ISO-8601                 | Server clock                                                                                                                                                                                                  |
| `actorType`                                    | `'client' \| 'system'`   |                                                                                                                                                                                                               |
| `actorHash`                                    | string \| null           | Requester hash; never a raw phone/IP                                                                                                                                                                          |
| `purpose`, `challengeId`, `jobId`, `phoneHash` | string \| null           | Correlation; `phoneHash` is a 64-hex HMAC                                                                                                                                                                     |
| `outcome`                                      | `'success' \| 'failure'` |                                                                                                                                                                                                               |
| `reasonCode`                                   | string \| null           | Stable machine-readable reason (`wrong_code`, `locked`, `expired`, `cooldown`, `phone`, `provider error code`, …)                                                                                             |
| `ttlAtMs` / `ttlAt`                            | number / Timestamp       | Retention mirror (90 days default)                                                                                                                                                                            |

Audit writes are best-effort: a failing audit write logs a warning but never breaks the OTP
flow (`SafeAuditSink`).

## 7. Not stored (deliberate)

- **Plaintext OTPs:** code exists only in memory (generation → message → provider) and as a
  keyed hash at rest.
- **Plaintext phone numbers:** only `phoneHash` is persisted. The E.164 number is held in
  memory for the request that created it and passed transiently to the delivery provider.
- **Message body / destination on job documents (D-019):** Phase 2 does not persist them.
  Consequence: a job that was never dispatched cannot be replayed after a crash — the
  challenge simply expires, the user retries, and a database leak can never reveal a live
  OTP. Phase 4 (relay claims) may need to persist destination/body and will re-open this
  decision explicitly with retention/encryption requirements.

## 8. Open questions (tracked)

1. D-023: Firestore TTL policy configuration for `ttlAt` (operations task; Phase 7).
2. D-019 extension in Phase 4: relay-claimable job payload storage.
3. Retention windows per collection (compliance item 5; audit retention currently 90 days
   as a code default).
4. Reverse lookup (UID → phone) is intentionally absent; only revisit with an approved
   Phase 3 requirement.
