# Phase 3 Identity Resolution and Custom-Token Design (Approved)

**Status: APPROVED — DECISION MATRIX RESOLVED (owner 2026-10-17, D-031).** Implementation
proceeds subphase by subphase under the gates in `docs/PHASE3_PLAN.md`. Current runtime
behavior is unchanged until subphase 3.4 ships the approved `verifyOtp` contract. If
implementation reveals a conflict with these decisions or an unsafe assumption, work stops
and reports rather than changing the design silently.

**Date:** 2026-10-17 · **Owner direction:** `docs/DECISIONS.md` D-030 (approved
2026-10-17). **Related decisions:** D-013, D-024, D-018, D-028, D-020, D-009, D-025,
D-029.

**Authorization context:** emulator-first implementation only. No real Firebase project
access, no deployments, no real SMS, no secret provisioning, no custom tokens to real
clients, no CoolBus changes.

---

## 1. Purpose and scope

Resolve the correct Firebase identity after a successful, consumed OTP challenge and issue
a Firebase custom token only then — without duplicate account creation, account takeover,
or corruption of existing identity relationships.

In scope: phone → identity resolution, creation policy, attachment rules, conflict
handling, token lifecycle, retries/partial failures, trusted attributes, audit fields,
residual-risk policy.

Out of scope: roles, profiles, registration UX, CoolBus integration (Phase 6), relay
(Phase 4), account-recovery behavior, phone linking (not approved; `phone-verification`
remains reserved per D-028 and owner direction #5).

## 2. Sources of truth

| Record                                  | Role                                                                                                                       | Notes                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Firebase Authentication                 | **Authoritative identity source** (owner direction #1): UID, user record, disabled state, `phoneNumber`                    | Admin SDK (`getUser`, `getUserByPhoneNumber`, `createUser`) |
| `identity_links/{phoneHash}` (proposed) | Backend-owned **cache / claim / recovery record** (owner direction #2); never independent authority, never client-readable | Correctness must not depend on it — see §2.1                |
| `otp_challenges` (implemented)          | Time-bound **proof of phone possession**; single-use; stores `phoneHash` only                                              | Raw E.164 is never persisted at rest (Phase 2 design)       |
| `audit_events` (implemented)            | Privacy-preserving security events                                                                                         | No tokens, codes, raw phones (§8)                           |
| CoolBus                                 | Authorization, profiles, roles (owner direction #8)                                                                        | Untouched                                                   |

### 2.1 Rotation and authority invariant

`identity_links` keys are `HMAC(pepper, "phone:v1:" + e164)` and therefore change on pepper
rotation. `getUserByPhoneNumber(e164)` is pepper-independent. **Invariant:** Firebase Auth
remains correct even if every link document is lost, stale, or re-keyed; links are filled
or refreshed from Auth on every resolution and may always be rebuilt.

### 2.2 How the verified E.164 reaches resolution (input binding)

Phase 2 does not persist the E.164. Therefore the `verifyOtp` request gains a **required
`phone` field** (decision **ID-9**). The server normalizes it, and the identity work uses
that E.164 **only if** `HMAC(pepper, "phone:v1:" + e164)` equals the challenge's stored
`phoneHash`, validated inside the same transaction that consumes the challenge. The phone
is a _locator for the already-created challenge_, never an identity input: possession of a
code plus a mismatched phone can never resolve to any identity.

## 3. Existing identities

### 3.1 Resolution order

For a consumed `sign-in` challenge with verified E.164:

1. **Link cache** — read `identity_links/{hash(current pepper, e164)}`:
   - `active`: candidate UID. Confirm with Auth (`getUser`): user exists, not disabled, and
     `phoneNumber` equals the verified E.164. Any drift → **fail closed** (`identity.conflict`,
     no token, no link mutation; operator resolution path only).
   - `revoked`: fail closed (`identity.conflict`); a revoked link is an explicit
     administrative state and blocks creation (ID-1 condition 3).
   - `pending_creation`: another resolution is in flight or previously crashed — see §4.3.
   - absent: continue to step 2.
2. **Authoritative lookup** — `getUserByPhoneNumber(e164)`:
   - found → write/refresh the link under the current pepper key (cache fill, also the
     pepper-rotation re-key path), audit `identity.link.filled`, proceed with that UID;
   - user-not-found → step 3.
3. **New identity policy** — §4.

### 3.2 Preservation of existing identities

Resolution returns the existing UID; the service never deletes, merges, or re-points Auth
users or links, and never modifies email, displayName, custom claims, providers, or any
profile data. Tokens are issued only for the resolved UID.

### 3.3 Missing, stale, duplicate, conflicting, incomplete mappings

| Case                                                          | Behavior                                                                                                                                      |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Link absent, Auth user exists                                 | Fill cache; proceed (safe: Auth authoritative)                                                                                                |
| Link `active`, Auth user deleted                              | Fail closed `identity.conflict`; no auto-recreate (deletion may be intentional)                                                               |
| Link `active`, Auth user disabled                             | Fail closed `identity.conflict`                                                                                                               |
| Link `active` but `uid` missing/incomplete                    | Fail closed `identity.conflict` (treat as corrupt record)                                                                                     |
| Link `active`, Auth `phoneNumber` differs from verified E.164 | Fail closed `identity.conflict`                                                                                                               |
| Link `active` uid ≠ `getUserByPhoneNumber` result             | Fail closed `identity.conflict`                                                                                                               |
| Two links for one phone                                       | Impossible (document id = phone hash); noted for completeness                                                                                 |
| Two Auth users with one phone                                 | Firebase rejects duplicate `phoneNumber` (emulator-verified in 3.5; real behavior in 3.7); if ever observed → fail closed `identity.conflict` |
| `pending_creation` claim not expired                          | Bounded retry (§4.3); then `IDENTITY_UNAVAILABLE`                                                                                             |
| `pending_creation` claim expired                              | Reclaim after re-checking Auth (§4.3)                                                                                                         |

"Fail safely" means: no identity is guessed, no user or link is mutated on conflict, the
client receives only the generic post-verification error (§6.4), and the internal reason is
recorded in audit events.

## 4. New identities

### 4.1 Creation conditions (ID-1 — exact, approved basis; owner direction #3)

A new Auth user is created **only when all of the following hold**:

1. `verifyChallenge` returned `verified` (challenge atomically consumed; purpose `sign-in`;
   phone binding validated in the consuming transaction).
2. The link for the current phone hash is absent — not `active`, not `revoked`.
3. `getUserByPhoneNumber(e164)` returns user-not-found (authoritative).
4. A creation claim for the phone is acquired transactionally (§4.3).
5. Immediately after the claim commits, `getUserByPhoneNumber(e164)` is checked **again**
   (user-not-found confirmed a second time); a user appearing here is resolved instead of
   created (recovery for a previous crash-after-create).
6. Client-allowed purpose is `sign-in` (engine-level purposes unchanged; §5 of
   `docs/PHASE3_PLAN.md`).

Creation calls `createUser({ phoneNumber: e164 })` with no email, no claims, no profile
fields; Firebase assigns the UID.

### 4.2 Duplicate-phone recovery and idempotent retries (ID-1)

- `createUser` fails with `auth/phone-already-exists` → re-run `getUserByPhoneNumber`:
  - found → finalize the link to that UID and proceed (this is the race-recovery path,
    including a concurrent creator that finished first);
  - still not found → fail closed `identity.conflict` (audit reason
    `phone_already_exists_unresolved`).
- Any other `createUser` error → release the claim when possible; fail closed.
- Retrying a resolution after a **partial** failure never duplicates: if creation
  succeeded but finalization failed, the next resolution finds the user in step 1.5/3.1
  and finalizes the link. A created user is **never deleted** on failure (deletion could
  race with a concurrent resolution that already discovered it).
- If the client never retries, an unlinked Auth user with the verified phone may remain;
  it is discoverable by phone, no token was ever issued for it, and the next successful
  resolution links it. No reconciliation job is proposed in Phase 3 (recorded as future
  work).

### 4.3 Claim protocol (serialization and recovery)

Serialized by a Firestore transaction on `identity_links/{phoneHash}`:

1. Transaction reads the current state:
   - absent → write `{ status: 'pending_creation', claimId, claimedAtMs, expiresAtMs,
pepperVersion }`; proceed as claim holder.
   - `pending_creation` with `expiresAtMs > now` → not holder: bounded retry (below).
   - `pending_creation` with `expiresAtMs <= now` → take over: re-check Auth first
     (step 1.5); if user-not-found, replace the claim (new `claimId`) and proceed as
     holder; if found, finalize the link to the found UID and proceed.
   - `active`/`revoked` → §3.1/§3.3 behavior.
2. Outside the transaction: second Auth lookup (step 1.5), then `createUser`, then a
   second transaction finalizing `{ status: 'active', uid, verifiedAt }` (keeping
   `phoneHash` as the document id and current `pepperVersion`).

Policy constants proposed: `IDENTITY_CLAIM_TTL_SECONDS = 120`; non-holder claim retry:
up to 3 resolution attempts with 150 ms backoff, then `IDENTITY_UNAVAILABLE`.

## 5. Phone attachment and conflicts (ID-3)

- **Sign-in flow (Phase 3, only approved path):** attachment occurs exclusively through
  authoritative discovery — the phone is already on the Auth record (`getUserByPhoneNumber`)
  or already recorded in an active link. The service never attaches a verified phone to a
  client-chosen account.
- **Linking flow:** not approved; requires the caller to prove account ownership (ID token)
  _and_ phone possession, and a separate owner decision (owner direction #5). Reserved for
  `phone-verification` (D-028).
- **Concurrency:** claim transaction (§4.3); in practice the single-live-challenge rule and
  single-use consumption already make concurrent first-time resolution impossible via the
  public API — the claim protects crash/retry overlaps and direct-resolver races.
- **Consistency with Auth:** links are only ever written from an Auth-confirmed outcome; a
  divergence detected at resolution fails closed. Periodic link↔Auth reconciliation is
  future work (Phase 5/7), recorded so the gap is explicit; Phase 3 relies on
  resolve-time detection instead.

### 5.4 Account takeover and phone-number reassignment (ID-8 — approved for controlled pilot only)

- Phone numbers can be reassigned by carriers. Possession of a currently verified phone
  number therefore does **not** establish continuity of account ownership.
- In this model, if a verified number is already linked to a UID, a later possessor of the
  reassigned number can obtain a session for that UID (standard phone-auth residual). If the
  number is not linked, the flow creates a new empty account that grants no access to any
  existing account.
- **Owner decision (2026-10-17, D-031): policy A — accept and monitor, for controlled
  pilot only.** This acceptance does not authorize an unrestricted real-user launch. Before
  real-user rollout, account recovery, number reassignment, and account revocation policy
  must be revisited. No new recovery behavior (auto-transfer, auto-delete, step-up, freezes)
  is implemented without a separate owner decision.
- Monitoring: identity audit events (ID-7 fields) provide traceability; session revocation
  tooling (`revokeRefreshTokens`) is future work (Phase 7).

## 6. Verification-to-token lifecycle (ID-4, ID-5, ID-9)

### 6.1 Ordering (approved direction #6, #7)

1. The verify transaction validates phone binding (ID-9), purpose, expiry, attempts, and
   code, and atomically consumes the challenge on success (existing Phase 2 behavior).
2. Only after consumption: identity resolution (§3–§5), then
   `createCustomToken(resolvedUid)`.
3. The token is returned in the callable response only.

Phone-binding mismatch is treated as a generic verification failure (`CODE_INVALID`), is
**not** consumed, and does **not** increment the attempt counter (it can only occur through
client error; the code remains valid for the correct phone). Audit reason:
`phone_mismatch`.

### 6.2 Consume-first consequences (ID-4 — documented trade-off)

- A consumed challenge is spent: replaying the same code after any post-consumption failure
  is rejected (existing semantics, unchanged).
- Recovery after a post-consumption failure is: request a new OTP and verify again, subject
  to existing per-phone/per-requester/global limits. No automatic server-side retry exists.
- **No exactly-once token delivery is promised.** Guarantees are: at-most-once consumption
  per challenge; at-most-one token minted per consumed challenge attempt; a failure between
  consumption and response yields no token and requires a fresh OTP.
- Rationale for not adding a re-issue window: it would let any holder of a consumed code
  mint tokens repeatedly, breaking single-use. Rejected.

### 6.3 Token handling restrictions (ID-5)

- Custom tokens exist only in handler memory and in the direct callable response.
- **Never** written to Firestore, logs, audit events, or error messages (assertion tests in
  subphase 3.4 and 3.5).
- `createCustomToken` uses the resolved UID only; no custom claims are added (roles stay in
  CoolBus, owner direction #8).
- Firebase custom tokens are stateless and short-lived (service-side TTL is Firebase-owned
  and not configurable here); clients must call `signInWithCustomToken` immediately and must
  not persist the token. Server-side revocation of an already-minted custom token is not
  possible; `revokeRefreshTokens` (session-level) is future tooling (Phase 7).

### 6.4 Exact response and error contract (ID-5 — approved 2026-10-17)

Success (`verifyOtp` result):

```json
{ "verified": true, "purpose": "sign-in", "customToken": "<firebase-custom-token>" }
```

- No TTL field is added: Firebase owns custom-token expiry; adding `expiresInSeconds` would
  advertise a value the service does not control.
- No other fields; no `uid`, no profile data, no phone echo.

Post-verification failures (resolution conflict, claim in progress, Auth/Firestore outage,
token minting failure) all map to one generic surface:

- callable status `unavailable`, `details: { "code": "IDENTITY_UNAVAILABLE" }`, fixed
  message (e.g. "Unable to complete sign-in right now"), **no** internal reason, no
  `retryId`; internal reason only in audit events.
- Verification-stage failures keep the existing mapping (`CODE_INVALID`,
  `RATE_LIMITED`, `RESEND_COOLDOWN`, `SERVICE_UNAVAILABLE` for delivery) unchanged.

## 7. Trusted attributes and authorization (approved direction #8)

**Trusted (server-derived):** consumed challenge facts (challengeId, purpose, phoneHash,
pepperVersion), the E.164 only via validated hash binding (ID-9), server clock/windows,
Firestore transaction outcomes, Firebase Admin results (UID, user record, disabled state),
deployment configuration.

**Untrusted (never authorization-bearing):** UID, role, operator/driver id, email, display
name, any profile attribute, client-suggested claims, challengeId (opaque capability
locator), and the `phone` field itself (a locator only, admitted solely through hash
equality).

**Separation rule:** a verified phone yields a session for the resolved UID and nothing
else. Roles, profiles, and entitlements remain CoolBus-owned; no role or profile is ever
granted or inferred here.

## 8. Data and audit additions (ID-7 — approved with safeguards)

`identity_links/{phoneHash}` fields: as §4.3 plus `createdAt`, `updatedAt`, `verifiedAt`,
`lastChallengeId`, `pepperVersion`, `ttlAtMs` (long-lived retention; no TTL cleanup in
Phase 3).

Audit events: `identity.resolved`, `identity.created`, `identity.link.filled`,
`identity.conflict`, `identity.claim.expired`, `token.issued`, `token.issue_failed` — plus
new verification audit reason `phone_mismatch`.

**Recommended minimum fields:** existing event envelope (`eventId`, `type`, `occurredAt`,
`actorType`, `actorHash`, `purpose`, `challengeId`, `outcome`, `reasonCode`, `ttlAtMs`)
plus `phoneHash` (epoch pseudonym, for abuse correlation) and `uid` (non-secret identifier
already known to CoolBus, for identity traceability). Explicitly excluded: raw phone
numbers, OTP codes, custom tokens, ID tokens, claims, profile data.

Access and retention: Admin SDK only (rules deny-all, already tested); same `audit_events`
collection with the existing 90-day default (`auditRetentionSeconds`) — retention review
remains Phase 5/compliance work.

## 9. Failure catalogue (final proposed behavior)

| Scenario                                          | Behavior                                                                                     |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Phone binding mismatch                            | Generic `CODE_INVALID`; challenge not consumed; no attempt increment; audit `phone_mismatch` |
| Link active, user valid                           | Resolve; mint; respond                                                                       |
| Link drift (missing/disabled/mismatch/incomplete) | `IDENTITY_UNAVAILABLE`; audit `identity.conflict`; no mutation                               |
| Link absent, Auth found                           | Fill link; resolve                                                                           |
| Link absent, Auth not found, conditions met       | Claim → re-check → create → finalize → resolve                                               |
| Claim in progress (< TTL)                         | Bounded retry; then `IDENTITY_UNAVAILABLE`                                                   |
| Claim expired                                     | Re-check Auth; finalize if found; else reclaim and create                                    |
| Creation succeeded, finalize failed               | `IDENTITY_UNAVAILABLE`; next resolution recovers via Auth; user never deleted                |
| `phone-already-exists` during create              | Re-check Auth; finalize if found; else `IDENTITY_UNAVAILABLE`                                |
| Token minting throws                              | `IDENTITY_UNAVAILABLE`; audit `token.issue_failed`; challenge stays consumed                 |
| Firestore unavailable during claim/finalize       | `IDENTITY_UNAVAILABLE`; audit best-effort                                                    |
| Any post-consumption failure                      | Fresh OTP required; no exactly-once promise                                                  |

## 10. Decision matrix (resolved — owner decisions 2026-10-17, D-031)

| ID   | Decision                                                                              | Status                                                                                                                           | Notes                                                                                                                                                                                                                                                                                                                                                            |
| ---- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ID-1 | New-user creation policy                                                              | **Approved (basis)** — owner direction #3; exact conditions + duplicate-phone recovery + idempotent retry documented in §4.1–4.3 | Conditions refine, not extend, the approved basis                                                                                                                                                                                                                                                                                                                |
| ID-2 | Set `phoneNumber` on created users                                                    | **Approved conditionally** (owner direction #4)                                                                                  | Conditional on Auth-emulator validation in subphase 3.5; invariant: E.164 comes only from the validated challenge binding (ID-9), never from client identity claims                                                                                                                                                                                              |
| ID-3 | `identity_links` = cache/claim/recovery; Auth authoritative                           | **Approved** (owner direction #2); fail-safe semantics finalized in §3.3                                                         | —                                                                                                                                                                                                                                                                                                                                                                |
| ID-4 | Strict consume-first single-use                                                       | **Approved** (owner direction #6); consequences and recovery documented in §6.2                                                  | No exactly-once promise                                                                                                                                                                                                                                                                                                                                          |
| ID-5 | `customToken` response + error contract + token restrictions                          | **Approved (owner 2026-10-17)**                                                                                                  | Success shape `{ verified: true, purpose: "sign-in", customToken }`; no TTL field; generic `IDENTITY_UNAVAILABLE` for post-verification failures; sanitized internal observability; tokens never logged/persisted/audited                                                                                                                                        |
| ID-6 | Restrict Phase 3 to `sign-in`; reject other purposes at the API boundary              | **Approved** (owner direction #5, D-028)                                                                                         | Handler-level allowlist implemented in subphase 3.4                                                                                                                                                                                                                                                                                                              |
| ID-7 | Audit identity fields                                                                 | **Approved with safeguards (owner 2026-10-17)**                                                                                  | Envelope + `phoneHash` and UID only where relevant; no raw phones/codes/tokens/client claims; backend-admin-only; 90-day retention enforced before real deployment; `phoneHash` is correlation-only and never authorizes resolution or access                                                                                                                    |
| ID-8 | Recycled phone-number policy                                                          | **Approved for controlled pilot only (owner 2026-10-17)**                                                                        | Policy A (accept + monitor) per §5.4; verified possession does not establish continuity of ownership; recovery/reassignment/revocation policy revisited before real-user rollout; no new recovery behavior without a separate decision                                                                                                                           |
| ID-9 | Require `phone` in `verifyOtp` and validate hash binding in the consuming transaction | **Approved with conditions (owner 2026-10-17)**                                                                                  | Canonical E.164 normalization; same versioned pepper as creation; comparison inside the consuming transaction; mismatch ⇒ generic `CODE_INVALID`, unconsumed, no attempt increment, no disclosure; challenge-bound phone only; regression tests: wrong-phone substitution, normalized-equivalent representations, transaction races, unchanged state on mismatch |

### Related gates

| Gate                       | Status                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-018 callable protection  | Direction approved for planning (recommend App Check; unauthenticated confined to isolated test setup); **final policy decision pending before Phase 3 concludes**              |
| D-020 pepper provisioning  | Approved direction: document local/emulator + propose Secret Manager for the isolated test project; **no provisioning**; implementation-time change is a Phase 3.7 prerequisite |
| D-009 deployment packaging | **Blocked** for real deployment; esbuild direction recommended; Phase 3 is emulator-first and unaffected                                                                        |
| D-028 purpose semantics    | **Approved**: `sign-in` only; `phone-verification` reserved and rejected at the API boundary                                                                                    |
| F1–F3                      | Fixed in the current change set; must not regress                                                                                                                               |
| F4                         | Retained: explicit `OTP_ENVIRONMENT` mandatory in every deployment checklist                                                                                                    |

## 11. Emulator vs real-project validation limits

Validatable with the Auth emulator (subphase 3.5, to confirm): `createUser({ phoneNumber })`,
`getUserByPhoneNumber`, duplicate-phone rejection, disabled-user behavior,
`createCustomToken`, client `signInWithCustomToken`.

Must remain **unverified** until a separately approved isolated test-project run (3.7):
real token exchange and claims, production lookup consistency, duplicate-phone enforcement
under real concurrency, App Check behavior.

## 12. Design-gate acceptance criteria (status 2026-10-17)

1. ✅ Owner resolved ID-5, ID-7, ID-8, ID-9 (D-031); D-018 final policy is recorded as due
   before Phase 3 concludes.
2. ⏳ `docs/API_CONTRACT.md` is updated with the approved `verifyOtp` input/output contract
   during subphase 3.4 (implementation gate).
3. ⏳ Threat model lists identity-added threats (spoofed resolution, phone-binding bypass,
   claim races, takeover residual) with their tested mitigations before subphase 3.2.
4. Implementation proceeds subphase by subphase per `docs/PHASE3_PLAN.md`; each subphase
   reports its exact diff and results and stops at its gate.
