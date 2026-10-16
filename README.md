# OTP Infrastructure Service

Provider-independent OTP authentication backend that preserves Firebase identity.

The service verifies OTP challenges on a trusted backend, resolves the correct Firebase
identity, and issues Firebase custom tokens so clients can sign in with
`signInWithCustomToken` while keeping their existing Firebase UID and profile.

## Current status

**Phase 1 — Independent Repository and Architecture Foundation: READY FOR REVIEW.**

This repository currently contains only the Phase 1 foundation:

- A minimal, runnable Cloud Functions (TypeScript) skeleton with a `health` endpoint.
- A documented delivery-provider contract (`@otp-infra/contracts`) and a mock delivery
  provider used for local development only.
- Unit tests, linting, formatting, type checking, and CI configuration.
- Architecture, threat model, data model, API contract, decision log, and the master
  roadmap in `docs/`.

The OTP engine, Firebase identity integration, Android SMS relay, real SMS delivery, and
CoolBus integration are **not implemented**. They are specified in
`docs/OTP_INFRASTRUCTURE_MASTER_ROADMAP.md` as future phases and require explicit approval.

## Safety rules

- Never point this project at the CoolBus production Firebase project or any production
  credentials.
- The mock delivery provider refuses to run with `NODE_ENV=production`.
- Local development uses Firebase Emulator Suite demo projects (`demo-*`), which are
  fully offline by convention.
- No secrets are stored in the repository. `.env.example` contains placeholders only.

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
npm ci                # install workspace dependencies
npm run build         # compile contracts + functions
npm run typecheck     # strict TypeScript checks
npm run lint          # ESLint
npm run format:check  # Prettier
npm test              # Vitest unit tests
```

Run the Firebase Emulator Suite with a fully offline demo project:

```bash
npm run emulators     # firebase emulators:start --project demo-otp-infrastructure-service
```

## Repository layout

```
functions/            Cloud Functions backend (TypeScript)
  src/health.ts       health endpoint logic (pure + express handler)
  src/delivery/       delivery adapters (mock provider in Phase 1)
packages/contracts/   shared delivery-provider contract (types only)
tests/unit/           Phase 1 unit tests
docs/                 roadmap, architecture, threat model, data model, API contract, decisions
.github/workflows/    CI (format, lint, typecheck, build, test)
```

Planned modules (`otp/`, `identity/`, `rate-limiting/`, `audit/`, integration/security/e2e
tests, Android relay) are intentionally not created yet; see the roadmap.

## Documentation index

| Document                                                                               | Purpose                                                      |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [docs/OTP_INFRASTRUCTURE_MASTER_ROADMAP.md](docs/OTP_INFRASTRUCTURE_MASTER_ROADMAP.md) | Source of truth: seven phases, statuses, acceptance criteria |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                                           | Components, boundaries, data flows                           |
| [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)                                           | Assets, trust boundaries, threats, mitigations               |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md)                                               | Proposed collections and field-level handling                |
| [docs/API_CONTRACT.md](docs/API_CONTRACT.md)                                           | Endpoints, error envelope, semantics                         |
| [docs/DECISIONS.md](docs/DECISIONS.md)                                                 | Architecture decision log                                    |

## License

UNLICENSED — private project. All rights reserved.
