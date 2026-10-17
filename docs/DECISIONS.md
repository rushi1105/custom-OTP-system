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
- **Status:** Accepted and implemented (Phase 1).

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
- **Status:** Open — finalized with test evidence in Phase 3.

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
  story must be decided with the client app (Phases 3–6).
- **Status:** Open — revisit before Phase 3 client testing and Phase 7 hardening.

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
