# Architecture Decision Log

**Status:** Applies to all phases. New decisions are appended with the next id. A decision
is only `Accepted` when the owner has approved it (or it was executed as part of an
approved phase). Open decisions that block a phase are marked `Open — blocks Phase N`.

Status values: `Proposed` · `Accepted` · `Rejected` · `Superseded` · `Open`.

---

## D-001 — Independent repository with separate Git history

- **Date:** 2026-10-17
- **Context:** The service must be developed and tested without touching CoolBus's
  repository, credentials, or production Firebase project.
- **Alternatives:** build inside CoolBus with a feature folder; fork CoolBus.
- **Rationale:** Isolation prevents accidental production coupling; independent CI, tests,
  and release process were explicit requirements.
- **Consequences:** Some duplication (tooling, config) and a later deliberate integration
  step (Phase 6). CoolBus remains untouched until approved.
- **Status:** Accepted (executed in Phase 1).

## D-002 — Backend stack: TypeScript + Firebase Cloud Functions v2

- **Date:** 2026-10-17
- **Context:** Need a trusted backend that integrates with Firebase Auth custom tokens,
  runs cheaply at pilot volume, and is testable offline.
- **Alternatives:** standalone Node server on Cloud Run; other languages (Go/Dart);
  serverless framework elsewhere.
- **Rationale:** Firebase Admin SDK and Emulator Suite integration; managed HTTPS
  endpoints; existing team familiarity; TypeScript type safety for security logic.
- **Consequences:** Coupling to Firebase platform for hosting (not for correctness);
  workspace packaging must be validated against the Firebase deploy tooling later (D-009).
- **Status:** Accepted for Phase 1 scope (skeleton only). Revisit only via a new decision.

## D-003 — Pin TypeScript 5.9.x instead of 7.x

- **Date:** 2026-10-17
- **Context:** `typescript@latest` is 7.0.2 at the time of writing, while
  `typescript-eslint@8.71.2` declares peer support `>=4.8.4 <6.1.0`.
- **Alternatives:** TypeScript 7 with linting disabled/lagged; a different linter; no
  type-aware linting.
- **Rationale:** Keeping lint support on the supported path is more valuable than the new
  compiler for a security-critical project; 5.9 is stable and widely supported.
- **Consequences:** Revisit when typescript-eslint supports TS 7; upgrade is a small,
  isolated change.
- **Status:** Accepted (Phase 1).

## D-004 — CommonJS output for Cloud Functions

- **Date:** 2026-10-17
- **Context:** Node runtime supports both CJS and ESM; emulator/deploy edge cases are more
  numerous with ESM today.
- **Alternatives:** ESM (`"type": "module"`).
- **Rationale:** CJS is the path of least friction for Cloud Functions v2 and the emulator;
  the code itself stays module-clean (import syntax, `.js` extensions in relative imports).
- **Consequences:** If ESM becomes necessary, change `module`/package type and re-run the
  full test suite.
- **Status:** Accepted (Phase 1).

## D-005 — npm workspaces monorepo with an explicit contracts package

- **Date:** 2026-10-17
- **Context:** Delivery contract must be shared by backend and future relay/provider
  tooling without publishing packages.
- **Alternatives:** single package; pnpm/yarn workspaces; git submodule.
- **Rationale:** npm ships with Node (no extra tool install), workspaces resolve
  cross-package imports locally, and a dedicated `@otp-infra/contracts` package makes the
  replaceability boundary explicit and type-enforced.
- **Consequences:** Deploy packaging needs validation (D-009). Contracts are currently
  type-only exports, so no runtime dependency is created accidentally.
- **Status:** Accepted (Phase 1).

## D-006 — Mock delivery provider is default and production-guarded

- **Date:** 2026-10-17
- **Context:** Development and tests must never send real SMS; a real provider must never be
  silently replaced by the mock.
- **Alternatives:** mock only in tests; environment-variable switch without guard.
- **Rationale:** Fail-closed: `MockDeliveryProvider` throws when `NODE_ENV=production`,
  reports `confirmedDelivery: false` by contract, and records messages in memory only.
- **Consequences:** Real adapters must implement the same contract; contract behavior is
  asserted by unit tests that real adapters will inherit/port.
- **Status:** Accepted and implemented (Phase 1). **Partially superseded by D-025**
  (2026-10-17): `NODE_ENV` is no longer the production gate; provider selection is governed
  by the explicit `OTP_ENVIRONMENT` policy. The `NODE_ENV` check remains as defense in
  depth only.

## D-007 — Target Node.js 22; local development verified on Node 24

- **Date:** 2026-10-17
- **Context:** Firebase Cloud Functions officially supports Node 22 and 20 (18 deprecated);
  the development machine runs Node 24.
- **Alternatives:** Target Node 24 for functions (not in Firebase's supported list at time
  of writing); require Node 22 locally.
- **Rationale:** Deploy target should use the officially supported runtime; local tooling
  (Vitest 5, ESLint 10, firebase-tools 15) supports Node 24.
- **Consequences:** CI runs Node 22 (matches deploy target); local runs Node 24. Any
  runtime-version-sensitive behavior must be checked in CI. Re-verify the support matrix
  before Phase 7 deployment.
- **Status:** Accepted (Phase 1).

## D-008 — Android relay repository location

- **Date:** 2026-10-17
- **Context:** An Android app has a Gradle/Android Studio build lifecycle that differs from
  this Node monorepo; the roadmap permits adjusting structure.
- **Alternatives:** `apps/android-sms-relay/` inside this repo; separate repository.
- **Rationale:** No decision can be made responsibly before Phase 4 requirements are
  confirmed (signing, CI, release cadence).
- **Consequences:** No Android code exists yet; `apps/` is deliberately absent.
- **Status:** Open — must be decided before Phase 4 implementation; owner approval required.

## D-009 — Deployment packaging for npm workspaces

- **Date:** 2026-10-17
- **Context:** Firebase CLI deploys `functions/` and historically has friction with
  monorepos/workspace dependencies (`@otp-infra/contracts` resolves via workspace symlink).
- **Alternatives:** bundle with esbuild before deploy; switch contracts to a file dependency
  at deploy time; publish contracts package; keep contracts type-only (current state).
- **Rationale:** Current code has no runtime import of contracts, so Phase 1 is unaffected.
  A concrete approach is needed only when deployment is in scope.
- **Consequences:** Must be resolved and tested in the emulator before any real deployment;
  candidate: predeploy esbuild bundle.
- **Status:** Open — blocks real deployment (Phase 3 at the earliest; Phase 7 latest).
  Phase 3 planning assessment and evidence: `docs/PHASE3_PLAN.md` §5 (recommended direction:
  esbuild predeploy bundle; local simulation showed the isolated tree yields a dangling
  workspace junction, not a hard failure).

## D-010 — Deploy region `asia-south1`

- **Date:** 2026-10-17
- **Context:** Primary users (CoolBus) and the future SMS provider (MSG91-class) are in
  India; latency and compliance expectations favor an India region.
- **Alternatives:** `us-central1` (historical default), other regions.
- **Rationale:** Lower latency for Indian clients and better alignment with provider
  infrastructure.
- **Consequences:** Region is fixed per function; changing later requires redeploy. Confirm
  regional service availability (Firestore/Auth location is project-level) before Phase 3.
- **Status:** Proposed.

## D-011 — Firestore as the challenge/data store

- **Date:** 2026-10-17
- **Context:** Challenge state must support atomic single-use consumption and short-lived
  TTL data; the stack is Firebase-based.
- **Alternatives:** Realtime Database; Redis/Memorystore; Cloud SQL.
- **Rationale:** Transactions + TTL policies + Admin SDK + emulator support; no new
  infrastructure. Open questions: persisting message bodies, counter contention, rate-limit
  bucket cost.
- **Consequences:** Rate limiting via Firestore counters may need revisiting at scale
  (documented in DATA_MODEL §8).
- **Status:** Accepted (2026-10-17, implemented in Phase 2). Evidence: `DocumentDatabase`
  transaction abstraction + `FirestoreDocumentDatabase` with a 20-attempt retry budget; unit
  - emulator concurrency tests (10-way verify race, 5-way duplicate-request race) pass.
    Message bodies/destinations are not persisted (D-019); TTL policies deferred (D-023).

## D-012 — OTP policy values (implemented)

- **Date:** 2026-10-17
- **Context:** Initial policy values are needed for Phase 2 implementation and tests.
- **Alternatives:** longer codes, shorter TTL, SMS-retry behavior variants.
- **Rationale:** Industry-standard starting point; all values are server-enforced and
  audited. Implemented: 6 digits, 300 s TTL, max 5 attempts, 60 s resend cooldown, phone
  3 req/15 min, requester 10 req/10 min and 20 verify/10 min, global 60 req/min.
- **Consequences:** Values are code constants (`DEFAULT_OTP_POLICY`) changeable only by a
  reviewed commit; they must be tuned in Phase 5 with observed abuse data.
- **Status:** Accepted (2026-10-17, implemented and covered by Phase 2 tests).

## D-013 — Identity resolution and custom-token strategy

- **Date:** 2026-10-17
- **Context:** Must resolve a verified phone number to the correct existing Firebase UID,
  create users only when appropriate, and never trust client UIDs.
- **Alternatives:** rely on Firebase Phone Auth directly (rejected: couples to provider and
  bypasses our challenge system); create user per verification (rejected: duplicates);
  maintain external identity DB (out of scope).
- **Rationale:** `identity_links` mapping keyed by phone hash gives deterministic, testable
  resolution; conflicts fail closed.
- **Consequences:** Requires a dedicated test Firebase project (Phase 3, approval required)
  and explicit tests for phone attachment, session restoration, and missing profiles.
  App Check adoption for API endpoints remains an open sub-question.
- **Status:** Open — finalized with test evidence in Phase 3. Phase 3 design approved
  (D-031); implementation begins at subphase 3.1 (fakes only): `docs/IDENTITY_DESIGN.md`.

## D-014 — Environment and project separation

- **Date:** 2026-10-17
- **Context:** Development must never touch CoolBus production; real behavior still needs
  a real Firebase project eventually.
- **Alternatives:** emulator-only (cannot prove production behaviors); reuse CoolBus
  project (forbidden).
- **Rationale:** Demo-prefixed emulator projects for local/CI; dedicated test/staging/
  production projects created only with owner approval; CoolBus production is never used
  for this service's development or testing.
- **Consequences:** Phase 3 requires a new, owner-approved Firebase test project.
- **Status:** Accepted constraint (from the owner brief).

## D-015 — Secret management

- **Date:** 2026-10-17
- **Context:** Pepper(s), device credentials, and future provider keys must not live in the
  repo or plaintext config.
- **Alternatives:** `.env` files in deployment; config documents in Firestore.
- **Rationale:** Cloud Secret Manager with function-bound secrets (`defineSecret`) is the
  standard Firebase path; versioned pepper enables rotation.
- **Consequences:** Local/emulator uses non-secret placeholders; rotation procedures are
  Phase 7 deliverables.
- **Status:** Proposed.

## D-016 — CoolBus rollout mechanism

- **Date:** 2026-10-17
- **Context:** Integration must be reversible without touching existing users.
- **Alternatives:** hard cutover; per-user staged rollout; remote config flag.
- **Rationale:** A server-controlled feature flag with phone-auth fallback preserves the
  existing path during migration.
- **Consequences:** Implementation and flag ownership belong to the CoolBus architecture
  amendment (Phase 6); this repo only exposes the API.
- **Status:** Proposed — Approval required (Phase 6).

## D-017 — CI provider and remote publishing

- **Date:** 2026-10-17
- **Context:** A CI workflow file exists; the repository has no remote.
- **Alternatives:** GitHub Actions (file present); other CI providers.
- **Rationale:** GitHub Actions matches likely hosting; workflow runs format/lint/
  typecheck/build/tests.
- **Consequences:** Creating a remote repository, publishing code, or pushing commits
  requires explicit owner approval; `gh` CLI is not installed on the current machine, so
  remote creation is not currently available.
- **Status:** Proposed — Approval required to publish; local workflow file only.

## D-018 — Firebase App Check adoption for the API

- **Date:** 2026-10-17
- **Context:** Callable endpoints currently accept unauthenticated callers (callable
  verification logs `app: MISSING, auth: MISSING` in the emulator).
- **Alternatives:** enforce App Check now; defer until a client exists; never.
- **Rationale:** Phase 2 has no real client; App Check attestation cannot be tested in the
  emulator meaningfully. Rate limits + phone/global caps are the current controls.
- **Consequences:** Before any production exposure, App Check enforcement and its emulator
  story must be decided with the client app (Phases 3–6). Decision requirement: by the end
  of Phase 3 client sign-in testing, either (a) adopt App Check (with a documented
  emulator/local story) or (b) formally accept unauthenticated callable access with
  compensating controls (phone/global caps, alerting) recorded in the threat model.
- **Status:** Open — decision required before Phase 3 concludes. Owner direction (D-030):
  App Check recommended; unauthenticated callable access stays confined to the isolated
  test setup until an explicit policy is approved. Phase 3 planning proposal (pending owner
  approval): `docs/PHASE3_PLAN.md` §2 — unauthenticated callables remain test-only; App
  Check enforcement (or recorded acceptance with compensating controls) required before
  real users.

## D-019 — Delivery job documents do not persist message body or destination

- **Date:** 2026-10-17
- **Context:** A relay (Phase 4) needs destination + body at claim time; storing them
  persists OTP plaintext and phone numbers at rest. Phase 2 uses the mock provider only.
- **Alternatives:** persist like a message queue (simplest for the relay); persist encrypted;
  persist nothing (chosen for Phase 2).
- **Rationale:** Strongest privacy/security posture: a Firestore leak can never reveal a
  live OTP or phone number; the code hash is one-way. Trade-off: a job interrupted before
  dispatch cannot be replayed; the challenge expires and the client retries.
- **Consequences:** Phase 4 must explicitly re-open this decision for relay-claimable jobs
  (encryption, short retention, or transient-only delivery), with threat-model updates.
- **Status:** Accepted for Phase 2; revisit in Phase 4.

## D-020 — OTP pepper via environment variable now, Secret Manager later

- **Date:** 2026-10-17
- **Context:** The HMAC pepper is the key to all stored hashes; it must not live in the repo.
- **Alternatives:** Cloud Secret Manager with `defineSecret` now; environment variable with
  fail-fast validation now (chosen); committed dev secrets (rejected).
- **Rationale:** No deployment exists in Phase 2; `defineSecret` would complicate emulator
  and local workflows without adding protection for un-deployed code. Validation requires
  ≥ 32 characters (`OTP_HASH_PEPPER`), with `OTP_HASH_PEPPER_VERSION` recorded per record.
- **Consequences:** Before any real deployment (Phase 7, at the latest), the pepper must
  move to Secret Manager; rotation invalidates live challenges by design
  (`pepper_version_mismatch` is tested) and requires a documented runbook.
  Phase 3 proposal (pending approval): `docs/PHASE3_PLAN.md` §4 — Secret Manager via
  `defineSecret` for the isolated test project; identity resolution is pepper-rotation safe
  because Firebase Auth is the authoritative lookup (`docs/IDENTITY_DESIGN.md`).
- **Status:** Accepted for Phase 2; Secret Manager binding is a Phase 7 prerequisite.

## D-021 — Callable functions and IP-based control limitations

- **Date:** 2026-10-17
- **Context:** The API is implemented as Firebase callable functions; requester rate limits
  hash `rawRequest.ip` + User-Agent.
- **Alternatives:** onRequest with explicit IP handling; unauthenticated onCall (chosen).
- **Rationale:** Callable gives the future client SDK a typed, integrated path and carries
  callable protocol error semantics (D-022).
- **Consequences / limitations:** `rawRequest.ip` can be a proxy/load-balancer address
  (making IP buckets less precise or shared); User-Agent adds little entropy; callers
  without App Check/auth can rotate both. Therefore phone-number limits and the global cap
  are the primary abuse controls, and IP limits are a secondary signal. Revisit with App
  Check (D-018) and, if needed, trusted-proxy header parsing with validation.
- **Status:** Accepted for Phase 2 (documented limitation).

## D-022 — Client-facing error mapping through HttpsError details

- **Date:** 2026-10-17
- **Context:** Clients need stable machine-readable errors without leaking internal state.
- **Alternatives:** custom HTTP server (onRequest) with own envelope; callable errors with
  stable `details.code` (chosen).
- **Rationale:** Keeps the standard callable contract while carrying our taxonomy
  (`INVALID_REQUEST`, `CODE_INVALID`, `RATE_LIMITED`, `RESEND_COOLDOWN`,
  `SERVICE_UNAVAILABLE`) in `error.details.code`, plus `retryAfterSeconds` where relevant.
- **Consequences:** Every failed verification maps to one generic `CODE_INVALID` regardless
  of internal reason (wrong/expired/locked/consumed/voided/unknown/purpose mismatch); the
  internal reason appears only in audit events. Tests assert this mapping.
- **Status:** Accepted (implemented Phase 2).

## D-023 — Firestore TTL policies deferred to operations

- **Date:** 2026-10-17
- **Context:** Collections accumulate documents (challenge retention 24 h, audit 90 days).
- **Alternatives:** configure TTL policies per collection now; rely on manual cleanup;
  write `ttlAt` mirrors now and configure policies at deploy time (chosen).
- **Rationale:** TTL policies are project-level operations configuration; the emulator does
  not validate them. Correctness never depends on cleanup (expiry enforced by the engine
  clock), so this is purely a storage-cost/retention concern.
- **Consequences:** Before production (Phase 7), TTL policies must be configured on the
  `ttlAt` field of every collection and verified in a real project; documented as a Phase 7
  task.
- **Status:** Proposed (ops task; `ttlAt` mirrors already written and emulator-verified).

## D-024 — Identity strategy deliberately undecided in Phase 2

- **Date:** 2026-10-17
- **Context:** The owner brief forbids resolving the identity strategy by assumption during
  Phase 2 ("Do not resolve the identity-strategy decision by silently making assumptions").
- **Alternatives:** none available within scope.
- **Rationale:** Phase 2 verifies phone ownership only. It records `phoneHash` and `purpose`
  on challenges so Phase 3 can build resolution on verified facts, but issues no identity of
  any kind.
- **Consequences:** D-013 remains open; Phase 3 begins with a dedicated test Firebase project
  (owner approval required) and must explicitly decide phone-number attachment, existing-UID
  resolution, new-user creation policy, and conflict handling, each with tests.
- **Status:** Recorded (Phase 2 deliverable); D-013 is the phase-3 decision.

## D-025 — Explicit environment and delivery-provider policy (resolves review defect D1)

- **Date:** 2026-10-17
- **Context:** The adversarial review confirmed that the mock-provider production guard
  depended on `NODE_ENV`, which the platform populates (if at all) under an undocumented
  contract; Google advises against depending on runtime-populated variables. A deployed
  environment with unset `DELIVERY_PROVIDER` could therefore silently fall back to mock
  (fail-open to non-delivery).
- **Alternatives:** continue relying on `NODE_ENV` (rejected); block all mock usage behind a
  single boolean flag (insufficient: no environment semantics); explicit environment +
  provider policy (chosen).
- **Rationale / mechanism:**
  1. `OTP_ENVIRONMENT` ∈ `local | test | staging | production` is the single source of
     truth (`functions/src/config/env.ts`).
  2. Unset `OTP_ENVIRONMENT`: the Firebase emulator (`FUNCTIONS_EMULATOR=true`) resolves to
     `local`; a deployed runtime (`K_SERVICE` / `K_REVISION` / `FUNCTION_NAME`) fails closed;
     a plain developer process resolves to `local`.
  3. Provider selection: `local` defaults to mock; `test` requires an explicit provider and
     permits mock (approved tests); `staging`/`production` require an explicit non-mock
     provider. Unknown environment values and unknown provider names always fail closed.
  4. `createDeliveryProvider` enforces the same rules independently (defense in depth), and
     `MockDeliveryProvider` keeps its `NODE_ENV=production` guard as a third layer.
  5. Health reports the resolved environment (or `unconfigured`) via the same resolution
     logic, never throwing.
- **Limits:** deployment markers are runtime-populated and could change in a future
  platform revision; the deployment checklist (roadmap Phase 7) therefore requires
  `OTP_ENVIRONMENT` to be set explicitly for every deployed environment, with markers only
  as a fail-closed backstop.
- **Consequences:** `.env.example`, README, and API contract document the policy; the mock
  cannot be selected in any deployed environment through configuration or omission.
- **Evidence:** unit tests in `tests/unit/config.test.ts` (explicit environments, emulator
  inference, marker fail-closed, unknown values, missing provider, mock rejection in
  staging/production, defense-in-depth `NODE_ENV` guard) plus the health environment tests;
  all executed 2026-10-17 (see roadmap Appendix C).
- **Status:** Accepted (implemented in 0.2.1). Review defect D1 resolved.

## D-026 — Audit-failure monitoring requirement

- **Date:** 2026-10-17
- **Context:** The review confirmed that `SafeAuditSink` intentionally swallows backend
  failures (to protect the OTP flow) and logs `audit.write_failed` — but nothing alerts on
  lost security events.
- **Alternatives:** let audit failures break the OTP flow (rejected: availability over
  auditability for transient failures); swallow silently (rejected by review); swallow +
  require an alerting signal (chosen).
- **Rationale:** Losing audit events is acceptable for individual transient failures but not
  silently at scale; an alert converts silent loss into an operational signal.
- **Consequences / acceptance criteria:** a metric and alert on `audit.write_failed`
  occurrences must exist before real users (target Phase 5 validation; hard requirement
  Phase 7). Acceptance: simulated audit outage in staging raises the alert within one
  alerting window.
- **Status:** Proposed — required by Phase 5, hard requirement for Phase 7.

## D-027 — Delivery-job reconciliation requirement

- **Date:** 2026-10-17
- **Context:** The review confirmed that a crash between challenge commit and dispatch (or a
  failed receipt write) leaves `delivery_jobs` documents in `pending` state with no
  reconciliation or alerting.
- **Alternatives:** accept orphaned jobs as harmless (current state); synchronous
  confirmation (impossible with Firestore + external sends); reconciliation sweep + metrics
  (chosen direction).
- **Rationale:** Orphaned jobs mean silent non-delivery and misleading operational data.
  The Phase 4 job manager already needs claim/lease logic; pending-age reconciliation
  belongs there.
- **Consequences / acceptance criteria:** Phase 4 must add reconciliation for jobs stuck in
  `pending` beyond one challenge TTL and alert on it. Acceptance: an induced
  crash-before-dispatch in the test environment produces exactly one reconciliation event
  and one alert, and never a duplicate send (idempotency by `jobId`).
- **Status:** Proposed — required by Phase 4.

## D-028 — Challenge-purpose semantics must be defined before client exposure

- **Date:** 2026-10-17
- **Context:** `OTP_PURPOSES` currently contains `sign-in` and `phone-verification`, which
  are behaviorally identical in Phase 2. The purpose is bound into the challenge and code
  hash and enforced at verification, but the downstream consequences of each value are not
  defined.
- **Alternatives:** remove `phone-verification` from the allowlist until needed; define its
  semantics in Phase 3 (chosen).
- **Rationale:** Keeping the binding mechanism exercised is valuable; exposing an
  undefined-purpose value to clients is not.
- **Consequences / acceptance criteria:** before Phase 3 client work exposes purposes,
  record in D-013 what each purpose authorizes (identity resolution behavior, token
  issuance, account creation) with tests. Until then, clients should use `sign-in` only.
  Phase 3 proposal (pending approval): `docs/PHASE3_PLAN.md` §3 — restrict the API boundary
  to `sign-in`; keep `phone-verification` reserved for a future authenticated linking flow.
- **Status:** Open — required decision in Phase 3. Owner direction #5 (D-030, 2026-10-17)
  approves restricting Phase 3 to `sign-in` and rejecting other purposes at the API
  boundary; the handler allowlist is scheduled for subphase 3.4.

## D-029 — Phase 3 planning artifacts (proposals pending owner approval)

- **Date:** 2026-10-17
- **Context:** The owner authorized Phase 3 planning and emulator-first preparation only,
  with implementation gated on explicit decisions.
- **Artifacts:**
  - `docs/IDENTITY_DESIGN.md` — proposed identity resolution, creation/claim protocol,
    phone attachment/conflict rules, verification-to-token lifecycle, trusted-attribute
    model, and open decisions **ID-1…ID-8**.
  - `docs/PHASE3_PLAN.md` — D-018 callable-protection policy proposal, D-028 purpose
    semantics proposal, D-020 pepper provisioning proposal, D-009 packaging assessment
    (evidence-based), subphase plan 3.0–3.7, required-test coverage map, and approval
    checklist.
- **Rationale:** Phase 3 touches identity and token issuance; the adversarial-review
  discipline requires decisions to be written down and approved before code. Nothing in the
  artifacts changes current behavior or resolves D-013/D-018/D-020/D-028 by itself.
- **Consequences:** No identity or token code may be implemented until the owner approves the
  checklist in `docs/PHASE3_PLAN.md` §10. Approval will convert the relevant entries into
  final decisions (new or amended D-013/D-018/D-020/D-028 records).
- **Status:** Accepted as drafts by the owner (2026-10-17, D-030). Commit of the planning
  change set and implementation (subphase 3.1) occur only after the four pending matrix
  items (ID-5, ID-7, ID-8, ID-9) are confirmed.

## D-030 — Owner-approved Phase 3 direction (2026-10-17)

- **Date:** 2026-10-17
- **Context:** Owner decision gate on the Phase 3 planning artifacts (D-029); the artifacts
  were accepted as drafts and specific direction was approved for planning.
- **Approved direction (verbatim scope):**
  1. Firebase Auth remains the authoritative identity source.
  2. `identity_links` is a backend-owned cache/claim/recovery record, never independent
     authority over Firebase identity.
  3. New-user creation only after successful OTP verification and authoritative resolution
     establishes that no existing identity owns the verified phone number.
  4. Set the verified phone number on a newly created Auth user, subject to the final
     identity design and supported Auth-emulator behavior.
  5. Phase 3 is restricted to the `sign-in` purpose; no phone linking or additional
     purposes are exposed.
  6. Single-use OTP semantics retained; the consume-first trade-off and fresh-OTP recovery
     are documented; no exactly-once token delivery is promised.
  7. `customToken` is added to the successful `verifyOtp` response only after identity
     resolution succeeds; tokens are never persisted or logged.
  8. Role assignment, operator association, profile authorization, and access control stay
     separate from OTP verification.
  9. All implementation stays emulator-first: no real SMS, production credentials,
     real-project deployment, or CoolBus changes.
- **Also approved for planning:** D-018 recommendation (App Check; unauthenticated
  callables confined to the isolated test setup until an explicit policy is approved),
  D-020 documentation-only provisioning proposal (no secrets provisioned), D-009 kept
  blocked for real deployment, D-028 restricted to `sign-in`, F1–F3 fixes preserved, F4
  explicit `OTP_ENVIRONMENT` requirement retained.
- **Pending owner confirmation before implementation:** ID-5 exact response/error contract,
  ID-7 audit field list, ID-8 recycled-number policy choice, ID-9 `verifyOtp` phone-binding
  input; D-018 final policy before Phase 3 concludes.
- **Status:** Recorded (owner direction). Commit of the planning change set occurs only
  after the pending matrix items are confirmed.

## D-031 — Final Phase 3 identity decisions (ID-5, ID-7, ID-8, ID-9)

- **Date:** 2026-10-17
- **Context:** Owner decision gate resolving the four pending items in
  `docs/IDENTITY_DESIGN.md` §10; Phase 3.1 authorized on completion.
- **ID-5 (approved):** successful `verifyOtp` response is exactly
  `{ verified: true, purpose: "sign-in", customToken }`; no token TTL field.
  Post-verification identity/token failures map to the generic `IDENTITY_UNAVAILABLE`
  external error; no account-existence, link-state, or internal-detail disclosure.
  Internal observability stays sanitized; custom tokens are never logged, persisted,
  audited, or included in error messages.
- **ID-7 (approved with safeguards):** audit envelope plus `phoneHash` and UID only where
  relevant to the event; no raw phone numbers, OTP codes, custom tokens, or client-supplied
  identity claims; backend-admin-only access; 90-day retention proposed with actual
  enforcement required before real deployment; `phoneHash` is correlation-only and must
  never authorize identity resolution or access; omit UID/`phoneHash` where unnecessary.
- **ID-8 (approved for controlled pilot only):** policy A — accept and monitor. Possession
  of a currently verified phone number does not establish continuity of account ownership.
  This does not authorize an unrestricted real-user launch: account recovery, number
  reassignment, and account revocation policy must be revisited before real-user rollout;
  no new recovery behavior without a separate decision.
- **ID-9 (approved with conditions):** `verifyOtp` requires `phone`; normalize with the
  canonical E.164 policy; hash with the same configured, versioned pepper as creation;
  compare inside the same transaction that consumes the challenge. Mismatch ⇒ generic
  `CODE_INVALID`, challenge unconsumed, no attempt increment, no disclosure. Only the
  challenge-bound phone may feed Firebase identity resolution; the supplied phone must
  never select a UID or override an authoritative mapping. Required regression tests:
  wrong-phone substitution, normalized-equivalent representations, transaction races,
  unchanged state on mismatch.
- **Consequences:** Implementation proceeds subphase by subphase from 3.1 (fakes only) with
  reports and stops at each gate. D-018 final policy remains due before Phase 3 concludes;
  D-009 stays blocked; R1–R5 remain open; ID-2 remains conditional on Auth-emulator
  validation (3.5).
- **Status:** Accepted (owner decisions, 2026-10-17); supersedes the pending items in
  D-029/D-030.
