# API Contract

**Status:** `GET` health is **Confirmed** (Phase 1). `requestOtp` and `verifyOtp` are
**Implemented in Phase 2** as Firebase callable functions (v2, region `asia-south1`).
Relay endpoints remain **Proposed** (Phase 4). Custom-token issuance and identity
resolution are **implemented in Phase 3.4**; the client-SDK exchange boundary is exercised in
the Phase 3.5 emulator harness. Profile/role data remains CoolBus-owned and out of scope in
this repository.

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

`environment` reports the resolved runtime environment (`local` / `test` / `staging` /
`production`) using the same resolution logic as the runtime configuration, or
`unconfigured` when a deployed runtime is missing explicit configuration (D-025). It never
throws; health stays available during misconfiguration.

**Health is a liveness check only.** It does not prove that the OTP configuration is ready
(pepper, delivery provider, database availability are not probed). OTP endpoints fail closed
on invalid configuration regardless of the health response; use the `environment` label and
deployment logs as operational signals, and treat a deeper readiness probe as future work.

## 2. `requestOtp` (callable) — Implemented (Phase 2)

Input:

```json
{ "phone": "+919876543210", "purpose": "sign-in" }
```

- `phone`: required; normalized server-side (E.164; Indian local formats accepted).
- `purpose`: required; Phase 3 accepts only `sign-in`. `phone-verification` remains reserved
  and is rejected at the API boundary with `INVALID_REQUEST` (D-028/ID-6).

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

## 3. `verifyOtp` (callable) — Implemented (Phase 2; phone binding added in Phase 3.2)

Input:

```json
{
  "challengeId": "c_<opaque>",
  "code": "123456",
  "purpose": "sign-in",
  "phone": "+919876543210"
}
```

`phone` is **required** (ID-9): it is normalized with the canonical E.164 policy and admitted
only when its keyed hash equals the challenge's stored `phoneHash`. The comparison happens
inside the same transaction that consumes the challenge. The phone is a locator for the
already-created challenge, never an identity input.

Success response:

```json
{ "verified": true, "purpose": "sign-in", "customToken": "<firebase-custom-token>" }
```

The response contains no UID, profile data, or phone echo. The custom token exists only in
the callable response and handler memory; it is never logged, audited, or persisted. The
client must call `signInWithCustomToken` immediately and must not persist the token. No
custom claims are added.

Errors:

| Condition                                                                                           | status               | details.code           | Notes                                                             |
| --------------------------------------------------------------------------------------------------- | -------------------- | ---------------------- | ----------------------------------------------------------------- |
| Malformed input (bad id/code format, unknown purpose)                                               | `invalid-argument`   | `INVALID_REQUEST`      | —                                                                 |
| Wrong code, expired, locked, consumed, voided, unknown challenge, purpose mismatch, pepper rotation | `permission-denied`  | `CODE_INVALID`         | Deliberately indistinguishable                                    |
| Missing/malformed/oversized phone, phone mismatch (correct challenge otherwise)                     | `permission-denied`  | `CODE_INVALID`         | Challenge not consumed; attempts not incremented; no state change |
| Verify rate limit                                                                                   | `resource-exhausted` | `RATE_LIMITED`         | `retryAfterSeconds`                                               |
| Identity conflict/outage or custom-token failure after consumption                                  | `unavailable`        | `IDENTITY_UNAVAILABLE` | Challenge remains consumed; no token; request a fresh OTP         |

Rules (implemented and tested):

- Consumption is atomic; of N concurrent correct submissions exactly one succeeds
  (verified against the Firestore emulator with 10 concurrent requests).
- Phone binding is validated before any write: a phone mismatch or unusable phone leaves the
  challenge (`pending`, attempts unchanged) and the requester verify window unchanged. It is
  not counted against the per-requester verify limit (it is not a code-guessing attempt).
- Attempt limit is 5 failed verifications per challenge; the correct code is rejected after
  a lock.
- Resending voids a previous pending challenge for the same phone (superseded), so only one
  challenge is live per phone.
- Replay after success, after expiry, or after voiding is rejected.
- Consume-first semantics: after a successful code verification, any later identity or
  token failure requires a fresh OTP. No exactly-once promise spans Auth and Firestore.

## 4. Relay endpoints — Proposed (Phase 4)

Unchanged from Phase 1 planning: device-authenticated job claim (one-time lease), result
reporting (idempotent), heartbeat. To be finalized with the relay implementation.

## 5. Error code taxonomy (implemented subset)

| Code                   | Meaning                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `INVALID_REQUEST`      | Malformed or unsupported input                                                               |
| `CODE_INVALID`         | Generic verification failure (wrong/expired/consumed/locked/voided/unknown/purpose mismatch) |
| `RATE_LIMITED`         | Throttled; `retryAfterSeconds` present                                                       |
| `RESEND_COOLDOWN`      | Resend requested before the cooldown elapsed                                                 |
| `SERVICE_UNAVAILABLE`  | Delivery provider rejected/failed/crashed; challenge voided; safe to retry                   |
| `IDENTITY_UNAVAILABLE` | Post-verification identity/token failure; challenge stays consumed; request a fresh OTP      |
| `INTERNAL`             | Unhandled server error (callable default); no details leaked                                 |

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
- Logging: structured events (`otp.request.created`, `otp.verification.failed`,
  `identity.*`, `token.*`) contain challenge/job ids only — no codes, raw phone numbers,
  internal identity reasons, or custom tokens — verified by tests.
- CORS/auth: App Check adoption remains an open decision (D-018).

## 8. Client onboarding handoff (Phase 3.5)

No client application, profile store, or role model exists in this repository. The client
must exchange the `verifyOtp` custom token with Firebase Auth, then use the authenticated
UID with the CoolBus-owned profile/authorization APIs. The service never issues profiles,
roles, or custom claims.

Using the app's existing Firebase configuration (the emulator harness additionally calls
`connectAuthEmulator` and is test-only):

```js
const functions = getFunctions(app, 'asia-south1');
const verify = httpsCallable(functions, 'verifyOtp');
const { data: verified } = await verify({
  challengeId,
  code,
  purpose: 'sign-in',
  phone,
});

const credential = await signInWithCustomToken(getAuth(app), verified.customToken);
const uid = credential.user.uid; // canonical authenticated identity
const idToken = await credential.user.getIdToken();
```

- Exchange the token immediately. Do not persist or log the custom token; the Firebase SDK
  persists the resulting session using its platform storage. App-restart session
  restoration is therefore SDK/platform behavior and is not verified in this repository.
- Use `currentUser.uid` as the only client-side identity. Never send a client-authored UID,
  role, operator ID, student ID, or profile-ownership field as authorization.
- Send the Firebase ID token to profile/authorization backends; those backends must verify
  it and derive the UID server-side.
- `auth/invalid-custom-token` (malformed, invalid, or expired in production): discard the
  token and obtain a fresh OTP; do not retry the same token.
- `auth/network-request-failed`: retry the exchange with the same unexpired token. If the
  token expires, obtain a fresh OTP. The OTP challenge was already consumed.
- Backend failures before token issuance use the codes in section 3; `IDENTITY_UNAVAILABLE`
  means a fresh OTP is required.

Profile/onboarding contract (CoolBus-owned, **not implemented or verified here**):

1. Verify the Firebase ID token server-side and take the UID from it.
2. Look up the profile by that UID (document ID or unique key); never by a client-supplied
   UID or phone number.
3. Existing complete profile → restore it and route to the role-appropriate destination.
4. Missing/incomplete profile → route to registration/onboarding; create/update
   idempotently using the verified UID so retries cannot duplicate profiles.
5. Read roles, registration state, and ownership from trusted persisted records only; never
   accept them from request fields or custom claims.

Emulator limitation: the Firebase Auth emulator does not validate JWT signatures or expiry.
The Phase 3.5 harness verifies successful exchange, malformed-token rejection, network
failure/retry, and session observation; expired-token rejection and production token
behavior remain Phase 3.7 validation items.
