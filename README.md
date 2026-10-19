# OTP Infrastructure Service

Provider-independent OTP authentication backend that preserves Firebase identity.

The service verifies OTP challenges on a trusted backend, resolves the correct Firebase
identity, and issues Firebase custom tokens so clients can sign in with
`signInWithCustomToken` while keeping their existing Firebase UID and profile.

## Current status

**Phase 2 — Secure OTP Engine and Backend Foundation: READY FOR REVIEW** (Phase 1
APPROVED; adversarial review conditions remediated in 0.2.1 — awaiting re-review).

Implemented and tested:

- Trusted OTP challenge engine: CSPRNG codes, E.164 normalization, HMAC-SHA256 storage with a
  fail-fast-validated pepper, expiry, attempt limits, single-use atomic consumption,
  replay/concurrency protection, resend cooldown, per-phone/per-requester/global rate
  limits, enumeration-resistant responses, privacy-preserving audit events.
- Callable API: `requestOtp` and `verifyOtp` (Cloud Functions v2, `asia-south1`), plus
  `health`.
- Firestore-backed storage with a transaction abstraction; deny-all client security rules
  (tested against the emulator).
- Explicit, fail-closed environment and delivery-provider policy (D-025): the mock provider
  is only selectable in local/test; deployed environments require explicit
  `OTP_ENVIRONMENT` and a non-mock `DELIVERY_PROVIDER`.
- 158 automated tests (138 unit + 20 Firestore-emulator integration/security) across
  `tests/unit`, `tests/integration`, `tests/security`.

Not implemented (future phases, explicit approval required): Firebase identity resolution,
custom tokens, Android relay, real SMS, CoolBus integration, production deployment.

## Safety rules

- Never point this project at the CoolBus production Firebase project or any production
  credentials.
- Mock delivery is impossible outside `local`/`test`: `staging`/`production` require an
  explicit non-mock `DELIVERY_PROVIDER`, and a deployed runtime without explicit
  `OTP_ENVIRONMENT` fails closed at startup (D-025; `NODE_ENV` is only defense in depth).
- Local development uses Firebase Emulator Suite demo projects (`demo-*`), which are
  fully offline by convention.
- No secrets are stored in the repository. `.env.example` contains placeholders only; the
  real pepper is environment-provided (D-020).

## Requirements

- Node.js 22.13+ (verified locally on Node 24; Cloud Functions target runtime is Node 22)
- npm 10+ (verified with npm 12)
- Java 11+ only if you want to run the Firestore emulator locally
- Firebase CLI is available through `npx firebase` (installed as a dev dependency)

Notes for local development on Node 24 (**decision D-007**):

- `npm install` prints an `EBADENGINE` warning for `@otp-infra/functions` because its
  `engines.node` is `22` (the Firebase-supported deploy target). The warning is expected.
- The Functions emulator prints "requested node version 22 doesn't match your global
  version 24. Using node@24 from host." — expected; CI runs Node 22 to match the deploy
  target.

## Quickstart

```bash
npm ci                     # install workspace dependencies
npm run build              # compile contracts + functions
npm run typecheck          # strict TypeScript checks
npm run lint               # ESLint (includes CSPRNG/non-keyed-hash bans)
npm run format:check       # Prettier
npm test                   # unit tests (Vitest)
npm run test:integration   # Firestore-emulator integration + security-rules tests
```

The integration suite starts its own offline Firestore emulator (Java 11+ required;
first run downloads the emulator jar) against the `demo-` project:

```bash
npm run test:integration
# equivalent to:
# firebase emulators:exec --only firestore --project demo-otp-infrastructure-service "vitest run --config vitest.integration.mts"
```

Running the full local stack (Functions + Firestore emulators) requires the pepper.
Copy the example environment and start the emulators:

```bash
# Windows
Copy-Item .env.example functions\.env.local
# macOS/Linux
cp .env.example functions/.env.local

npm run emulators          # firebase emulators:start --project demo-otp-infrastructure-service
```

`functions/.env.local` is git-ignored; the committed `.env.example` contains placeholders
only. The engine validates the pepper on first invocation and fails closed if it is missing
or shorter than 32 characters.

## Repository layout

```
functions/            Cloud Functions backend (TypeScript)
  src/api/            callable handlers (requestOtp, verifyOtp) + requester context
  src/audit/          privacy-preserving audit events
  src/config/         fail-fast environment configuration
  src/delivery/       delivery contract mock, dispatcher, provider factory
  src/otp/            policy, phone normalization, CSPRNG, hashing, engine
  src/storage/        transaction abstraction + Firestore adapter
packages/contracts/   shared delivery-provider contract (types only)
tests/unit/           fast deterministic tests (138)
tests/integration/    Firestore-emulator engine tests
tests/security/       Firestore rules denial tests
tests/helpers/        in-memory database (optimistic concurrency), fixed clock, fakes
firestore.rules       deny-all client access rules (emulator-tested)
docs/                 roadmap, architecture, threat model, data model, API contract, decisions
.github/workflows/    CI (format, lint, typecheck, build, unit + emulator tests)
```

Planned modules (`identity/`, relay, provider adapters, e2e tests) are intentionally not
created yet; see the roadmap.

## Documentation index

| Document                                                                               | Purpose                                                         |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [docs/OTP_INFRASTRUCTURE_MASTER_ROADMAP.md](docs/OTP_INFRASTRUCTURE_MASTER_ROADMAP.md) | Source of truth: seven phases, statuses, acceptance criteria    |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                                           | Components, boundaries, data flows                              |
| [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)                                           | Assets, trust boundaries, threats, mitigations                  |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md)                                               | Proposed collections and field-level handling                   |
| [docs/API_CONTRACT.md](docs/API_CONTRACT.md)                                           | Endpoints, error envelope, semantics                            |
| [docs/DECISIONS.md](docs/DECISIONS.md)                                                 | Architecture decision log                                       |
| [docs/IDENTITY_DESIGN.md](docs/IDENTITY_DESIGN.md)                                     | Phase 3 identity/token design (final proposed; decision matrix) |
| [docs/PHASE3_PLAN.md](docs/PHASE3_PLAN.md)                                             | Phase 3 plan, proposals, and approval status                    |

## License

UNLICENSED — private project. All rights reserved.
