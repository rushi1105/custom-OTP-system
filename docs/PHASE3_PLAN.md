# Phase 3 Plan — Firebase Identity and Custom-Token Integration

**Status: PLANNING — IMPLEMENTATION BLOCKED ON OWNER APPROVAL.** This document prepares
Phase 3 only. No identity or token code may be written until the owner approves the
decisions in `docs/IDENTITY_DESIGN.md` §10 and the proposals in sections 2–5 below.

**Date:** 2026-10-17 · **Authorized scope:** planning and emulator-first preparation. No
real deployment, real SMS, production credentials, CoolBus access, or custom tokens issued
to real clients.

---

## 1. Authorization and gates

| Gate                         | Requirement                                                           | Status                                                                                  |
| ---------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Phase 2                      | Approved with conditions (owner message 2026-10-17)                   | ✅ conditions F1–F3 addressed in this change set; carried decisions tracked             |
| Identity design              | `docs/IDENTITY_DESIGN.md` decision matrix resolved (ID-1…ID-9)        | ✅ all items resolved and recorded (D-031, 2026-10-17)                                  |
| Callable protection (D-018)  | Recommendation recorded; final policy before Phase 3 concludes        | ✅ direction approved; final decision pending (not required for 3.1)                    |
| Purpose semantics (D-028)    | `sign-in` only; reserved purposes rejected at the API boundary        | ✅ approved (owner direction #5)                                                        |
| Pepper provisioning (D-020)  | Document local/emulator + propose Secret Manager; no provisioning     | ✅ direction approved (documentation only)                                              |
| Deployment packaging (D-009) | Direction approved; unchanged blocker for any real deploy (section 5) | ✅ keep blocked (no packaging work in Phase 3)                                          |
| Implementation               | Subphases 3.1+ only after all gates above                             | ✅ authorized 2026-10-17: 3.1 in progress (fakes only, no Firebase identity operations) |

## 2. D-018 — callable protection analysis and proposed test policy

### 2.1 Distinctions (requested explicitly)

- **Firebase Authentication** answers _who the caller is_. In this service the sign-in flow
  is inherently pre-authentication: the caller has no session yet, so authentication cannot
  be required on `requestOtp`/`verifyOtp`. It is required for _future_ account-linking
  operations (deferred, ID-6).
- **Firebase App Check** answers _whether the request comes from a genuine instance of the
  app_ (attestation: Play Integrity / DeviceCheck). It is abuse friction, not identity, and
  cannot be attested meaningfully in emulators.
- **Rate limiting** (already implemented) bounds volume per phone, per requester, and
  globally. It does not prove app authenticity and is bypassable with rotating client
  context (R2).
- **Abuse prevention** is the combination: rate limits + enumeration-resistant responses +
  attempt limits + monitoring/alerting (R1, R4) + optional App Check.

### 2.2 Proposed bounded test-only policy

1. **Local/emulator/test environments (current authorization):** unauthenticated callables
   remain permitted **only** because no real users exist; this is explicitly labeled
   test-only in `docs/DECISIONS.md` D-018 and must never be described as production-ready.
2. **Before any real-user deployment:** App Check enforcement (`enforceAppCheck: true`)
   is required, _or_ the owner records an explicit acceptance of unauthenticated access with
   compensating controls (rate limits + monitoring/alerting per R1/R4). Recommendation:
   adopt App Check.
3. **Decision timing:** D-018 is due before Phase 3 concludes (existing acceptance
   criteria), because Phase 3 is the first phase with a client sign-in flow that would
   otherwise be exercised unauthenticated against a real project.
4. **Limitations to record:** App Check cannot be validated locally; enforcement belongs in
   deployment configuration (Phase 7 prerequisite), not in Phase 3 code, unless the owner
   approves client-side integration early.

## 3. D-028 — challenge purpose semantics (approved direction)

| Purpose              | Permitted operations                                                                                                 | Client exposure (approved)                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `sign-in`            | Resolve identity (per design) and issue a custom token for the resolved UID; no profile/role changes                 | Yes — the only enabled purpose                                              |
| `phone-verification` | **Reserved.** Intended for future authenticated account-linking (ID token + OTP); no operations permitted in Phase 3 | No — rejected at the API boundary until the linking flow is approved (ID-6) |

Binding is already enforced: the purpose is included in the code hash
(`"code:v1:" + salt + ":" + purpose + ":" + code`), stored on the challenge, and checked at
verification (`purpose_mismatch`); the existing test suite covers rejection. Owner direction
#5 approved restricting Phase 3 to `sign-in`; the handler-level allowlist (ID-6, approved)
is implemented in subphase 3.4. The engine keeps both purpose values so the binding
mechanism stays exercised.

## 4. D-020 — pepper provisioning (approved direction: document, do not provision)

| Environment                                            | Mechanism (proposed)                                                                                                       | Notes                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Local/emulator                                         | `functions/.env.local` (git-ignored) with placeholder pepper; already documented in `.env.example`                         | Current behavior; no secret value is real                                 |
| CI                                                     | Non-secret, deterministic test pepper injected by the workflow environment; tests already construct configuration directly | Never reused outside tests                                                |
| Isolated test project (future)                         | **Secret Manager via `defineSecret('OTP_HASH_PEPPER')`** with `.secret.local` for emulator parity                          | Provisioning requires separate owner approval; nothing is provisioned now |
| Short-term alternative (not recommended for real data) | `functions/.env.<projectId>` dotenv file                                                                                   | Acceptable only if owner approves; riskier handling                       |

Owner direction approved documenting this configuration without provisioning. Rotation
procedure (proposed): add a new secret version, bump `OTP_HASH_PEPPER_VERSION` (strictly
validated, already implemented); live challenges created under the old version become
unverifiable (`pepper_version_mismatch`, implemented and tested) with ≤ 5-minute impact;
identity resolution is unaffected because Auth lookup is pepper-independent
(`docs/IDENTITY_DESIGN.md` §2.1); audit `phoneHash` values are per-epoch pseudonyms
(documented). Dual-pepper verification is intentionally not proposed (unneeded given TTL).
Rules: never hardcode, commit, log, or ship the pepper to clients; ≥ 32 characters enforced.

## 5. D-009 — workspace/deployment packaging assessment

### 5.1 Evidence collected (2026-10-17)

1. `functions/dist` contains **no runtime `require` of `@otp-infra/contracts`** (all imports
   are type-only and erased by `tsc`) — verified by scanning built artifacts.
2. Isolated simulation in a temporary sandbox (copy of `functions/package.json`, no workspace
   root, real `npm install --omit=dev` on npm 12): install **succeeds with a dangling
   junction** to the missing `../packages/contracts`; `require('@otp-infra/contracts')` in
   that tree fails with `MODULE_NOT_FOUND`.
3. Firebase's documented monorepo support (`codebase` property) manages multiple functions
   _source directories_; it does not document npm-workspace dependency resolution during
   deploy.
4. Therefore deployment behavior depends on the build environment's npm version and on
   whether any build step (e.g. `tsc`, whose type resolution needs the contracts package)
   runs during deploy — currently predeploy builds locally, but this is fragile and
   unverified against a real deploy.

### 5.2 Options

| Option                                        | Description                                                                                                                                                       | Assessment                                                                                                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. **esbuild predeploy bundle (recommended)** | Bundle `functions/src` to a self-contained `dist/index.js`; mark `firebase-admin`/`firebase-functions` external; deployed tree has no workspace/type dependencies | Removes the entire failure class; needs one new dev dependency and predeploy config; validate in an approved isolated environment before any deploy |
| B. Move contracts to `devDependencies`        | Relies on zero runtime use and on deploy not running type-checking                                                                                                | Cheap; leaves a dangling junction and depends on unverified deploy build behavior — fragile                                                         |
| C. Upload/publish contracts                   | Publish package or vendor code                                                                                                                                    | Rejected: publishing not authorized; vendoring duplicates the contract                                                                              |

### 5.3 Status

**Deployment remains a documented blocker** (D-009 open). Owner direction: keep real
deployment blocked until the packaging strategy is approved and verified; Phase 3 is
emulator-first and does not require packaging changes; option A (esbuild bundle) is the
recommended direction to validate before any real deploy.

## 6. Subphase plan (implementation only after approval)

Each subphase ends with checks run, diff reported, and an explicit stop at the defined gate.

### 3.0 — Decision gate (no code) — COMPLETE (2026-10-17)

- **Deliverable:** owner decisions on the matrix items — **completed** (D-030 direction;
  D-031 final decisions on ID-5, ID-7, ID-8, ID-9 with owner conditions).
- **Exit criteria:** decisions recorded in `docs/DECISIONS.md` / `docs/IDENTITY_DESIGN.md`;
  THIS document updated to remove blockers.

### 3.1 — Identity domain foundation

- **Objective/scope:** provider-agnostic identity interfaces, records, errors, claim types;
  no Firebase calls yet.
- **Files:** `functions/src/identity/{types,errors,resolver,identity-store}.ts`,
  `tests/helpers/identity-fakes.ts` (fake `AuthProvider`, in-memory identity store).
- **Data/API changes:** none (types only).
- **Security invariants:** no client identity inputs accepted anywhere; resolution inputs are
  `{ phoneHash, purpose, challengeId }` derived from the consumed challenge only.
- **Tests:** unit — store contract, claim lifecycle helpers, resolver decision table with
  fakes (link hit/miss, expired claim, revoked link).
- **Acceptance:** unit suite green; no Firebase imports in domain layer.
- **Rollback:** remove module (unreferenced).

### 3.2 — Existing-identity resolution

**Status: IMPLEMENTATION COMPLETE 2026-10-17 — awaiting owner review; not runtime-wired.**
Phone binding (ID-9), the Firestore identity-store adapter, the shared contract against both
implementations, F1 closure, F3/F4 audit semantics, and the pepper-rotation documentation are
implemented and tested. No creation or token issuance was added.

- **Objective/scope:** phone-binding validation in the consuming transaction (ID-9, if
  approved), resolution order (link cache → `getUserByPhoneNumber`), conflict detection,
  cache fill/re-key, no creation.
- **Files:** `functions/src/otp/engine.ts` (accepts the normalized phone's keyed hash and
  validates it inside the verify transaction), `functions/src/api/handlers.ts` (phone input
  passthrough), `functions/src/identity/resolver.ts`,
  `functions/src/identity/firestore-identity-store.ts`, `functions/src/storage/*`
  (read primitive + collection), phone-binding/store/resolver tests.
- **Data changes:** `identity_links` schema per `docs/IDENTITY_DESIGN.md` §8.
- **Security invariants:** the E.164 used for identity work is admitted only when
  `hashPhone(pepper, e164) === challenge.phoneHash`, validated inside the consuming
  transaction; mismatch → generic `CODE_INVALID`, not consumed, no attempt increment, audit
  `phone_mismatch`; drift/conflict → fail closed with `identity.conflict`; never re-point
  links; client UID never accepted.
- **Tests (ID-9 conditions):** wrong-phone substitution with a valid code → generic
  `CODE_INVALID`, challenge unchanged (status `pending`, attempts unchanged); the same phone
  supplied in normalized-equivalent representations (local, trunk-prefixed, country-prefixed)
  binds successfully to the challenge created from any equivalent form; transaction races
  (concurrent verify calls with mismatching phone vs correct phone → exactly one consumption,
  at most one success); mismatch audit reason `phone_mismatch`. Plus: existing UID
  resolution; link-miss fallback; pepper-rotation simulation (old-key miss → Auth fallback
  resolves and re-fills); disabled/missing/incomplete-user conflict; uid mismatch conflict.
- **Carried gates from the Phase 3.1 review — status 2026-10-17:**
  - **F1 — audit-sink failure semantics: CLOSED with evidence.** Chosen option: local
    defensive handling in `IdentityResolver.recordAudit` (a sink failure is caught and logged
    as `audit.write_failed`; resolution/conflict results are unaffected). Tests inject a
    throwing sink and prove a successful resolution and a settled conflict are still returned.
    This matches the established best-effort audit policy and does not depend on composition.
  - **F3/F4 — audit event semantics: RESOLVED.** Success events use `reasonCode: null` (engine
    convention); `uid` is omitted entirely when unknown. Exact-own-property assertions cover
    both.
  - **Pepper-rotation orphan links: DOCUMENTED** in `docs/IDENTITY_DESIGN.md` §2.3 (Auth
    remains authoritative; links re-key on next resolution; old-hash records are stale cache;
    cleanup requires an operator-reviewed migration in a later operations phase, with
    acceptance criteria). No cleanup behavior was introduced.
- **Acceptance:** all resolver and phone-binding tests green; audit events contain no
  tokens/codes/phones; the carried gates above are closed with evidence or scheduled.

### 3.3 — New-identity creation, idempotency, recovery

- **Objective/scope:** creation policy (per ID-1, approved basis), claim protocol with
  `IDENTITY_CLAIM_TTL_SECONDS = 120` and bounded non-holder retry (3 attempts, 150 ms),
  `createUser({ phoneNumber })` (per ID-2), partial-failure recovery.
- **Files:** `functions/src/identity/creation.ts` (or resolver extension), tests
  `tests/unit/identity-creation.test.ts`, emulator `tests/integration/identity-store.firestore.test.ts`.
- **Security invariants:** creation only after consumed `sign-in` challenge + double
  user-not-found; single creator per phone via claim transaction; never delete Auth users;
  `phone-already-exists` → recover-or-fail-closed.
- **Tests:** create-once; concurrent first-time resolution (Promise.all, in-memory +
  Firestore emulator with fake Auth); crash between create and finalize → recovery via Auth
  lookup; stale claim reclaim; `phone-already-exists` race; failure-injection via a
  throwing store/auth double.
- **Acceptance:** all creation/recovery tests green; exactly one Auth user per phone under
  contention.

### 3.4 — Verify→resolve→token integration

- **Objective/scope:** wire resolution + `createCustomToken` into the `verifyOtp` handler
  after consumption; exact response/error contract (ID-5, pending confirmation); purpose
  allowlist `['sign-in']` (ID-6, approved); identity audit events (ID-7, pending
  confirmation).
- **Files:** `functions/src/api/handlers.ts`, `functions/src/identity/*`,
  `functions/src/audit/audit-log.ts` (new event types), `docs/API_CONTRACT.md`.
- **API change:** `verifyOtp` input adds required `phone` (ID-9) and output adds
  `customToken` (ID-5); post-verification failures map to `unavailable` /
  `IDENTITY_UNAVAILABLE` per design §6.4; verification-stage errors unchanged.
- **Security invariants:** token only for resolved UID; never persisted/logged/audited
  (assertion tests over logs, audit, Firestore); consume-first semantics per design §6.2;
  client-supplied `uid`/`role` ignored by construction.
- **Tests:** success path; token-issuance failure → `IDENTITY_UNAVAILABLE`, challenge stays
  consumed; client `uid`/`role` escalation attempts rejected; unsupported purpose rejected
  at the API boundary; cross-purpose reuse rejected; no-token-leak assertions at handler and
  integration level; failure injection for `createCustomToken`.
- **Acceptance:** all leak/escalation/failure tests green.

### 3.5 — Auth-emulator integration

- **Objective/scope:** validate real Admin Auth behavior against the Auth emulator.
- **Files:** `tests/integration/identity.auth-emulator.test.ts`, `vitest.integration.mts`
  include (no config change if pattern already covered: `tests/integration/**`),
  `package.json` script `test:integration:auth` (emulators `--only auth,firestore`).
- **Tests:** `createUser({ phoneNumber })`; `getUserByPhoneNumber` round-trip; duplicate
  `phoneNumber` rejection; disabled-user behavior; `createCustomToken`; client
  `signInWithCustomToken` via the `firebase` client SDK against the emulator (documented as
  supported); resolver end-to-end against emulator Auth + Firestore.
- **Acceptance:** emulator suite green; untestable items listed in section 8 remain marked
  unverified.
- **Rollback:** tests only.

### 3.6 — Regression, hardening, and Phase 3 report

- **Objective/scope:** full Phase 2 regression proof; documentation finalization.
- **Files:** docs (`API_CONTRACT`, `DATA_MODEL`, `THREAT_MODEL`, `DECISIONS`, roadmap),
  any test adjustments (additions only).
- **Regression tests (all 11 required items in section 7):** rate limits, challenge
  lifecycle, audit behavior, provider fail-closed, retry exhaustion — existing suites run
  unchanged; no assertions weakened.
- **Acceptance:** complete test chain green; Phase 3 report with exact counts; R1–R5 still
  open where applicable.
- **Rollback:** documentation revert only.

### 3.7 — Isolated test-project validation (future, separately gated)

- **Not part of current authorization.** Requires separate owner approval, a dedicated
  test Firebase project (gate #3), Secret Manager provisioning (section 4), and the D-009
  packaging direction validated. Covers the emulator-untestable list (section 8).

## 7. Required-test coverage map (Gate 5)

| #   | Required test                                                      | Subphase                  |
| --- | ------------------------------------------------------------------ | ------------------------- |
| 1   | Existing UID resolution                                            | 3.2                       |
| 2   | New-user creation + idempotent retry                               | 3.3                       |
| 3   | Duplicate/conflicting phone mappings                               | 3.2, 3.3                  |
| 4   | Concurrent first-time resolution                                   | 3.3 (+3.5 emulator)       |
| 5   | Failure between creation and mapping persistence                   | 3.3                       |
| 6   | OTP consumption/retry behavior when token issuance fails           | 3.4                       |
| 7   | Prevention of custom-token leakage (logs/audit/Firestore)          | 3.4 (+3.5)                |
| 8   | Rejection of client-supplied identity/role escalation              | 3.2, 3.4                  |
| 9   | Cross-purpose challenge reuse rejection                            | existing + 3.4 regression |
| 10  | Callable security behavior under the selected test policy          | 3.4, 3.6                  |
| 11  | Phase 2 regression (rates, lifecycle, audit, provider fail-closed) | 3.6                       |

Carried from the Phase 3.1 review (tracked in §6, subphase 3.2): **F1** audit-failure
non-interference must be closed with evidence before runtime wiring (3.4); **F3/F4** audit
event semantics are decided/documented in 3.2 without expanding payloads; pepper-rotation
orphan-link cleanup is documented for 3.2 or a later phase.

## 8. Emulator-untestable behaviors (remain unverified until 3.7)

- Real custom-token exchange (custom token → ID token → refresh token) and exact claims.
- Production `getUserByPhoneNumber` consistency and duplicate-phone enforcement under real
  concurrency.
- Real App Check attestation and enforcement (D-018).
- Production Firestore contention at scale (carried from Phase 2 residual).

## 9. Risk register continuity

- **R1–R5** (section 23 of the roadmap) remain **open** with unchanged mitigations and
  acceptance criteria: R1 global-cap availability, R2 requester key, R3 orphaned jobs
  (Phase 4), R4 audit-loss alerting (Phase 5), R5 activity inference (monitor). Phase 3
  does not pull Phase 4 reconciliation work in; no genuine Phase 3 dependency was
  identified.
- **PR-1…PR-8** (roadmap section 21) are the separate project-risk register; identifier
  collision fixed in this change set (F1).
- D-026, D-027 remain `Proposed` until their implementations and evidence exist in their
  target phases.

## 10. Approval status (owner direction 2026-10-17, D-030)

The authoritative per-decision statuses live in `docs/IDENTITY_DESIGN.md` §10 (decision
matrix). Summary:

**Approved and resolved (D-031, 2026-10-17):** ID-1 (creation basis; exact conditions
documented), ID-2 (conditional on Auth-emulator validation, subphase 3.5), ID-3
(cache/Auth authority), ID-4 (consume-first), ID-5 (exact response/error contract + token
restrictions), ID-6 (`sign-in` only), ID-7 (audit fields with safeguards), ID-8 (policy A
for controlled pilot only; revisit before real-user rollout), ID-9 (required `phone` binding
with conditions), D-028, D-020 (document-only, no provisioning), D-009 (keep blocked).
Owner direction #1–#9 recorded in D-030; final decisions in D-031.

**Still pending (not blocking 3.1):** D-018 final policy timing — due before Phase 3
concludes.

Implementation proceeds subphase by subphase with a report and stop at each gate. Phase 3.1
is in progress using fakes only; no Firebase identity operations are performed in 3.1.
