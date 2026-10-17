# API Contract

**Status:** `GET` health is **Confirmed** (Phase 1). `requestOtp` and `verifyOtp` are
**Implemented in Phase 2** as Firebase callable functions (v2, region `asia-south1`).
Relay endpoints remain **Proposed** (Phase 4). Custom-token issuance is **not implemented**
(Phase 3).

Callable protocol: requests carry `{"data": {...}}`; successful responses carry
`{"result": {...}}`; errors carry `{"error": {"message", "status", "details"}}` where
`details.code` is the stable machine-readable code from this document.

Global rules (implemented):

- The server decides everything: clients never supply a UID, role, or verification state.
- No endpoint reveals whether a phone number belongs to an existing account (Phase 2 has no
  account lookup at all; the creation response is identical for every valid phone).
- No response contains OTP codes, hashes, pepper data, raw phone numbers, or internal ids
  beyond the opaque challenge id required for verification.
- All expiry/attempt decisions use the server clock.

## 1. `GET /health` — Confirmed

Implemented as the `health` Cloud Function. Returns non-sensitive service metadata
(`status`, `service`, `version`, `environment`, `timestamp`). No dependency probing, no
secrets, no configuration values.

## 2. `requestOtp` (callable) — Implemented (Phase 2)

Input:

```json
{ "phone": "+919876543210", "purpose": "sign-in" }
```

- `phone`: required; normalized server-side (E.164; Indian local formats accepted).
- `purpose`: required; one of `sign-in`, `phone-verification` (bound into the challenge and
  code hash).

Success response:

```json
{ "challengeId": "c_<opaque>", "expiresInSeconds": 300, "resendAfterSeconds": 60 }
```

Errors (`error.status` is the callable code; `error.details.code` is the stable code):

| Condition                                         | status               | details.code          | Extra               |
| ------------------------------------------------- | -------------------- | --------------------- | ------------------- |
| Malformed input / invalid phone / unknown purpose | `invalid-argument`   | `INVALID_REQUEST`     | —                   |
| Resend before cooldown                            | `resource-exhausted` | `RESEND_COOLDOWN`     | `retryAfterSeconds` |
| Per-phone / per-requester / global limit          | `resource-exhausted` | `RATE_LIMITED`        | `retryAfterSeconds` |
| Provider rejected, failed, or crashed             | `unavailable`        | `SERVICE_UNAVAILABLE` | `retryAfterSeconds` |

Delivery failure semantics: on any non-accepted provider outcome the challenge is voided
and the phone cooldown is cleared so the client may retry immediately (server-side limits
still apply). A `pending` challenge never became verifiable because of a failed send.

## 3. `verifyOtp` (callable) — Implemented (Phase 2)

Input:

```json
{ "challengeId": "c_<opaque>", "code": "123456", "purpose": "sign-in" }
```

Success response:

```json
{ "verified": true, "purpose": "sign-in" }
```

`customToken` is intentionally absent — it arrives with Phase 3 after identity resolution
is implemented and tested.

Errors:

| Condition                                                                                           | status               | details.code      | Notes                          |
| --------------------------------------------------------------------------------------------------- | -------------------- | ----------------- | ------------------------------ |
| Malformed input (bad id/code format, unknown purpose)                                               | `invalid-argument`   | `INVALID_REQUEST` | —                              |
| Wrong code, expired, locked, consumed, voided, unknown challenge, purpose mismatch, pepper rotation | `permission-denied`  | `CODE_INVALID`    | Deliberately indistinguishable |
| Verify rate limit                                                                                   | `resource-exhausted` | `RATE_LIMITED`    | `retryAfterSeconds`            |

Rules (implemented and tested):

- Consumption is atomic; of N concurrent correct submissions exactly one succeeds
  (verified against the Firestore emulator with 10 concurrent requests).
- Attempt limit is 5 failed verifications per challenge; the correct code is rejected after
  a lock.
- Resending voids a previous pending challenge for the same phone (superseded), so only one
  challenge is live per phone.
- Replay after success, after expiry, or after voiding is rejected.

## 4. Relay endpoints — Proposed (Phase 4)

Unchanged from Phase 1 planning: device-authenticated job claim (one-time lease), result
reporting (idempotent), heartbeat. To be finalized with the relay implementation.

## 5. Error code taxonomy (implemented subset)

| Code                  | Meaning                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `INVALID_REQUEST`     | Malformed or unsupported input                                                               |
| `CODE_INVALID`        | Generic verification failure (wrong/expired/consumed/locked/voided/unknown/purpose mismatch) |
| `RATE_LIMITED`        | Throttled; `retryAfterSeconds` present                                                       |
| `RESEND_COOLDOWN`     | Resend requested before the cooldown elapsed                                                 |
| `SERVICE_UNAVAILABLE` | Delivery provider rejected/failed/crashed; challenge voided; safe to retry                   |
| `INTERNAL`            | Unhandled server error (callable default); no details leaked                                 |

Reserved for later phases: `CHALLENGE_EXPIRED`, `TOO_MANY_ATTEMPTS` (audit-only today; the
public response stays generic).

## 6. Abuse controls visible to clients (implemented)

- Per phone: 3 requests / 15 min, 60 s resend cooldown.
- Per requester (hashed IP + User-Agent): 10 requests / 10 min, 20 verifies / 10 min.
- Global: 60 requests / minute.
- See D-021 for the documented limitations of IP-based controls in callable functions and
  behind proxies.

## 7. Cross-cutting semantics

- Idempotency: no automatic retries; a failed request never silently sends a second SMS.
- Logging: structured events (`otp.request.created`, `otp.verification.failed`, …) contain
  challenge/job ids only — no codes, no phone numbers — verified by tests.
- CORS/auth: App Check adoption remains an open decision (D-018).
