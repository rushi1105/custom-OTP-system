# OTP Infrastructure Service

[![CI](https://github.com/rushi1105/custom-OTP-system/actions/workflows/ci.yml/badge.svg)](https://github.com/rushi1105/custom-OTP-system/actions/workflows/ci.yml)

Provider-independent OTP authentication backend that verifies phone ownership, resolves the
authoritative Firebase identity, and issues a Firebase custom token so clients can sign in
with `signInWithCustomToken` while preserving their existing UID and profile.

**Status:** Phase 3 backend implementation is complete for OTP request/verification,
identity resolution/creation/recovery, and custom-token issuance. It is validated against
the Firebase Firestore and Auth emulators. It is **not** production-deployed; the only
implemented delivery provider is the mock provider.

## What it does

1. **Request an OTP** — normalize the phone to E.164, create a short-lived challenge, store
   only HMAC-SHA256 phone/code material, enforce rate limits, and dispatch through a
   replaceable delivery adapter.
2. **Verify an OTP** — validate the submitted phone against the challenge (ID-9 binding)
   and verify the code inside the same Firestore transaction that consumes the challenge.
3. **Resolve identity** — use Firebase Auth as the authoritative phone-to-UID source; fill
   or refresh the link cache, recover existing users, or create a new Auth user through a
   transactional creation claim.
4. **Issue a custom token** — return only
   `{ verified: true, purpose: "sign-in", customToken }`. The token is never persisted,
   logged, or audited.

## Implemented

- TypeScript / Node.js backend on Firebase Functions v2 (`asia-south1`).
- Firestore-backed challenge, rate-limit, delivery-job, identity-link, and audit storage.
- CSPRNG OTP codes, configurable policy, expiry, attempt limits, single-use consumption,
  replay protection, resend cooldown, and per-phone/per-requester/global abuse controls.
- HMAC-SHA256 challenge and phone hashing with a versioned pepper; fail-closed runtime
  configuration.
- ID-9 phone-binding validation before any challenge mutation.
- Transactional identity-creation claims, bounded retry, duplicate-phone recovery, and
  crash/claim-loss recovery without deleting Auth users.
- Firebase Admin Auth adapter and custom-token issuance.
- Privacy-preserving audit events with no raw phone, OTP, token, or HMAC values.
- Secret Manager binding for the deployed pepper (`defineSecret`) with an emulator-only
  local fallback.
- Deployment preflight and an isolated-test deployment/rollback runbook.
- 259 unit tests and 86 Firestore/Auth emulator integration/security tests (345 total),
  plus a CI workflow that runs formatting, linting, type checking, build, unit tests, and
  emulator tests.

## Architecture

```text
Callable API
  requestOtp / verifyOtp
        |
        v
OTP engine --------------------> Firestore
  challenge lifecycle,              challenges, rate limits,
  HMAC hashes, rate limits          delivery jobs, audit
        |
        v
Identity resolution -----------> Firebase Auth (authoritative)
  link cache / claim / recovery    UID, phoneNumber, disabled state
        |
        v
Custom-token issuance ---------> Firebase Auth custom token
```

The service never accepts a client-supplied UID, role, or profile ownership. The verified
phone comes from the consumed challenge, and the resolved UID comes from Firebase Auth.

## API

| Callable     | Purpose                                                    |
| ------------ | ---------------------------------------------------------- |
| `requestOtp` | Create an OTP challenge for a canonical `sign-in` request. |
| `verifyOtp`  | Consume the challenge, resolve identity, issue a token.    |
| `health`     | Non-sensitive liveness metadata.                           |

Successful verification returns:

```json
{ "verified": true, "purpose": "sign-in", "customToken": "<firebase-custom-token>" }
```

Post-verification failures are intentionally generic (`IDENTITY_UNAVAILABLE`); internal
reasons stay in backend audit events. See [docs/API_CONTRACT.md](docs/API_CONTRACT.md).

## Tests and CI

```bash
npm ci
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:integration
```

The integration suite starts isolated Firestore and Auth emulators against a `demo-`
project. It covers identity creation/recovery, duplicate-phone handling, claim contention,
phone binding, custom-token exchange, audit privacy, and security rules. CI runs the same
checks on Node 22.

## Local development

Requirements: Node.js 22.13+ (verified locally on Node 24), npm 10+, and Java 11+ for the
Firestore emulator.

```bash
Copy-Item .env.example functions\.env.local   # Windows PowerShell
# cp .env.example functions/.env.local         # macOS/Linux
npm run emulators
```

The mock delivery provider records messages **in memory only**; no real SMS is sent. The
local `.env.local`/`.secret.local` files are git-ignored; `.env.example` contains
placeholders only. A local Functions emulator may log a Secret Manager access warning and
use the local pepper fallback; that is expected. Full manual custom-token verification
requires a local test signing credential; the automated emulator suite provisions a
test-only credential for that flow.

If the Functions emulator reports a backend-discovery timeout on first load, restart it
once; this is a local tooling startup issue, not an OTP logic failure.

## Deployment readiness

`docs/DEPLOYMENT_READINESS.md` describes the isolated-test deployment configuration,
Secret Manager pepper binding, preflight checks, smoke procedure, and rollback. The
preflight is:

```bash
npm run build
npm run deploy:preflight
```

Deployment remains gated by D-009 packaging, D-018 callable protection/App Check, D-020
pepper provisioning, and Phase 3.7 real-Auth/token validation.

## Limitations and open decisions

- **Delivery is mock-only.** No Android SIM relay and no commercial SMS provider are
  implemented. A real phone cannot receive an OTP from this service yet.
- **No production deployment.** Deployment packaging (D-009), App Check/callable
  protection (D-018), and Secret Manager pepper provisioning (D-020) remain open owner
  decisions.
- **Production Auth validation is pending** (Phase 3.7), including real custom-token
  exchange and expired-token behavior.
- The callables are unauthenticated by design for pre-authentication sign-in; App Check is
  not enforced. Do not expose them to real users without resolving D-018.
- CoolBus profile/role onboarding is a separate integration and is not included here.

## Repository layout

```text
functions/
  src/api/           callable handlers
  src/audit/         privacy-preserving audit sink
  src/auth/          Firebase Auth adapter and token issuer port
  src/config/        fail-fast runtime configuration
  src/delivery/      provider contract, mock adapter, dispatcher
  src/identity/      resolver, creation claims, link store, audit helper
  src/otp/           policy, phone normalization, CSPRNG, hashing, engine
  src/storage/       transaction abstraction and Firestore adapter
packages/contracts/  shared delivery-provider types
tests/unit/          deterministic unit tests
tests/integration/   Firestore/Auth emulator tests
tests/security/      Firestore rules tests
scripts/             deployment preflight and guarded isolated-test seed helper
firestore.rules      deny-all client access
docs/                API, identity design, deployment readiness, and implementation notes
.github/workflows/   CI
```

## Documentation

- [API contract](docs/API_CONTRACT.md)
- [Identity design](docs/IDENTITY_DESIGN.md)
- [Phase 3 plan](docs/PHASE3_PLAN.md)
- [Deployment readiness](docs/DEPLOYMENT_READINESS.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Data model](docs/DATA_MODEL.md)

## License

MIT. See [LICENSE](LICENSE).
