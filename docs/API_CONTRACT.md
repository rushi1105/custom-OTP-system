# API Contract

**Status:** Everything below is **Proposed** except `GET /health`, which is **Confirmed**
implemented in Phase 1. No other endpoint exists in the repository.

Conventions (**Proposed**):

- HTTPS only; JSON request/response bodies; UTF-8.
- Version prefix `/v1`.
- Server determines all security outcomes; clients never assert identity, roles, or
  verification results.
- Errors use one envelope (see §5) with stable machine-readable codes and no PII.
- Timestamps are ISO-8601 UTC strings.

## 1. `GET /health` — Confirmed (implemented)

Implemented as the `health` Cloud Function (`functions/src/index.ts`).

Response `200`:

```json
{
  "status": "ok",
  "service": "otp-infrastructure-service",
  "version": "0.1.0",
  "environment": "development",
  "timestamp": "2026-10-17T00:00:00.000Z"
}
```

Contains no secrets, no configuration values, and no dependency status detail. A deeper
readiness probe (Firestore/provider health) is Phase 2+ work and must not leak internals.

## 2. `POST /v1/otp/requests` — Proposed (Phase 2)

Create a challenge and enqueue delivery.

Request:

```json
{ "phone": "+919876543210" }
```

`200` response (enumeration-resistant; identical shape whether or not an account exists):

```json
{ "challengeId": "<opaque>", "expiresInSeconds": 300, "resendAfterSeconds": 45 }
```

Behavior:

- Normalizes to E.164; invalid numbers are rejected with `INVALID_REQUEST` (not
  enumeration-revealing because it depends only on format).
- Applies rate limits (per phone hash, requester hash, global). Over limit →
  `429` + `RATE_LIMITED` with `retryAfterSeconds`.
- Resend before cooldown → `429` + `RESEND_COOLDOWN` (or silently reuse the live challenge
  — policy decided in Phase 2; must not reveal account existence).
- Never returns whether the number belongs to an existing user.

## 3. `POST /v1/otp/verifications` — Proposed (Phase 2/3)

Verify a code; on success return a Firebase custom token.

Request:

```json
{ "challengeId": "<opaque>", "code": "123456" }
```

`200` response:

```json
{ "customToken": "<firebase custom token>", "expiresInSeconds": 300 }
```

Failure responses (all with generic user-facing semantics; exact code mapping is Phase 2
policy):

| Condition                                      | HTTP | Code                                                                   |
| ---------------------------------------------- | ---- | ---------------------------------------------------------------------- |
| Malformed request                              | 400  | `INVALID_REQUEST`                                                      |
| Unknown/expired/consumed challenge, wrong code | 401  | `CODE_INVALID` (deliberately indistinguishable)                        |
| Attempt limit reached                          | 401  | `CODE_INVALID` (same as above; `TOO_MANY_ATTEMPTS` only in audit logs) |
| Rate limited                                   | 429  | `RATE_LIMITED`                                                         |
| Unexpected                                     | 500  | `INTERNAL`                                                             |

Rules:

- Consumption is atomic; exactly one of N concurrent correct submissions succeeds.
- Custom tokens are issued only inside the success path after consumption.
- The endpoint never accepts or returns a UID.

## 4. Relay endpoints — Proposed (Phase 4)

Device-authenticated (enrolled credential; never the same credentials as clients).
Candidate shape (finalized in Phase 4):

- `POST /v1/relay/jobs/claim` — claims at most one pending job; returns job id, destination,
  body, expiry, lease. Idempotent per device within the lease window.
- `POST /v1/relay/jobs/{jobId}/result` — reports `sent` or `failed` with reason code;
  idempotent; rejected after lease expiry; never echoes OTP content back.
- `POST /v1/relay/heartbeat` — health/last-seen, app version, SIM label.

Evidence levels recorded: relay accepted → Android submitted → carrier accepted → confirmed
delivery (relay can evidence at most Android submission).

## 5. Error envelope — Proposed

```json
{ "error": { "code": "RATE_LIMITED", "message": "Too many requests", "retryAfterSeconds": 30 } }
```

| Code                | Meaning                                                                         |
| ------------------- | ------------------------------------------------------------------------------- |
| `INVALID_REQUEST`   | Malformed/unsupported input                                                     |
| `CODE_INVALID`      | Generic verification failure (wrong/expired/consumed/locked)                    |
| `RATE_LIMITED`      | Throttled; see `retryAfterSeconds`                                              |
| `RESEND_COOLDOWN`   | Resend requested too soon                                                       |
| `CHALLENGE_EXPIRED` | Reserved for cases where revealing expiry is safe; not used publicly by default |
| `TOO_MANY_ATTEMPTS` | Reserved for internal/audit use; public responses stay generic                  |
| `INTERNAL`          | Unexpected server error; no details leaked                                      |

## 6. Cross-cutting semantics — Proposed

- **Idempotency:** challenge creation may accept an idempotency key in Phase 2 if double
  submissions from flaky clients become measurable; relay results are idempotent by design.
- **No client-supplied identity:** no endpoint accepts `uid`, `role`, or `verified` fields.
- **Time:** all expiry decisions use the server clock; clients are never trusted for time.
- **Logging:** requests/responses are logged with correlation ids only; codes, tokens, and
  raw phone numbers are never logged.
- **CORS/auth:** browser-origin access is not a target; the API is consumed by the app
  (and later CoolBus). App Check evaluation is an open decision (D-013/D-018 reserved).
