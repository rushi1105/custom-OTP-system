# OTP Infrastructure — Isolated-Test Deployment Readiness

**Status:** Configuration/preflight readiness implemented; no real deployment has been
performed. D-009 packaging and D-018 callable protection remain owner decisions. The only
implemented delivery provider is the mock provider, so a deployed smoke cannot deliver a
real SMS code.

This document covers the **standalone** service only. CoolBus profile/role authorization is
a separate workstream.

## 1. Target shape

- Cloud Functions v2 in `asia-south1` (`health`, `requestOtp`, `verifyOtp`).
- Firestore rules from `firestore.rules`.
- Firebase Auth project used for custom-token exchange. The OTP Functions and the client
  Auth project must be the same Firebase project; custom tokens are project-scoped.
- Firebase Admin uses the deployed runtime's Application Default Credentials. No service
  account key or credential file is committed or configured in this repository.
- Use a dedicated isolated test project, not the CoolBus production project.

## 2. Required configuration

| Variable/secret                     | Required deployed value            | Notes                                                                                                            |
| ----------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `OTP_ENVIRONMENT`                   | `test`                             | Explicit; deployed `local`/unset fails closed. This milestone is isolated test only.                             |
| `OTP_HASH_PEPPER_VERSION`           | positive integer, no leading zeros | Stored on challenges; increment on rotation.                                                                     |
| `DELIVERY_PROVIDER`                 | `mock` currently                   | No real delivery adapter exists. A deployed smoke needs a seed challenge or a future real adapter.               |
| `OTP_HASH_PEPPER`                   | Secret Manager secret              | Bound to both callables via `defineSecret`. Never set the real value in a committed or plaintext deployment env. |
| `FIREBASE_PROJECT_ID` / CLI project | isolated test project              | Not `coolbus-1db23`, not a `demo-` project.                                                                      |

Other existing runtime policy (challenge TTL, resend cooldown, rate limits, retention) is
unchanged.

## 3. Pepper provisioning (owner action, not performed)

The deployed code binds `OTP_HASH_PEPPER` through `defineSecret`. Before deployment, in the
isolated test project:

```bash
firebase functions:secrets:set OTP_HASH_PEPPER --project <isolated-test-project>
```

Provide a random value of at least 32 characters. Do not put it in `.env`, source, logs, or
this repository. Set `OTP_HASH_PEPPER_VERSION` centrally for the deployment and increment it
only when rotating the pepper. Existing challenges under an older version fail closed as
`pepper_version_mismatch`; identity resolution remains Auth-authoritative.

Local/emulator runs continue to use `functions/.env.local` or `functions/.secret.local`
(both git-ignored). The `OTP_HASH_PEPPER` env fallback in `index.ts` is enabled only when
`FUNCTIONS_EMULATOR=true`; a deployed function missing its Secret Manager value fails
closed instead of accepting a plaintext deployment env. The deployed function binds and
prefers the Secret Manager value.

## 4. Preflight

```bash
npm run build
OTP_ENVIRONMENT=test \
OTP_HASH_PEPPER_VERSION=1 \
DELIVERY_PROVIDER=mock \
FIREBASE_PROJECT_ID=<isolated-test-project> \
npm run deploy:preflight
```

On PowerShell, set the variables with `$env:...` before the command. The preflight:

- requires isolated-test configuration and rejects production/CoolBus/demo projects;
- verifies the build output, entry point, exports, and absence of a runtime
  `@otp-infra/contracts` import;
- verifies the Secret Manager binding and runtime read path;
- checks for tracked `.env`/service-account files;
- prints warnings for D-009, D-018, D-020, and mock delivery.

It does **not** contact Secret Manager, build a deployment package, or deploy.

## 5. Deployment gate

Do not deploy until the owner resolves D-009 (packaging), D-018 (callable protection), and
provisions the D-020 secret. Recommended D-009 direction is the committed plan's esbuild
predeploy bundle; the alternative is validating Firebase CLI workspace/file-dependency
packaging directly. This repository does not select or implement either packaging option
without that decision.

After those decisions, the isolated deployment command is expected to be:

```bash
firebase deploy --only functions,firestore:rules --project <isolated-test-project>
```

This command has **not** been executed. The non-secret runtime variables
(`OTP_ENVIRONMENT=test`, `OTP_HASH_PEPPER_VERSION`, `DELIVERY_PROVIDER`) must be applied to
the deployed Functions/Cloud Run environment by the selected deployment process; `.env`
files are local-only. Applying them reproducibly is part of the D-009 deployment
configuration decision.

## 6. Isolated-test smoke procedure

Local emulator tests already cover request/verify/identity/token/client exchange. For a
deployed isolated test project with mock delivery:

1. Deploy only after the D-009/D-018/D-020 gates are cleared.
2. Verify `GET /health` returns `status: ok` and the expected environment label.
3. Confirm unauthenticated callable access is confined to the isolated test project (D-018
   policy still open; do not expose real users).
4. Run `npm run build` (the seed script imports the compiled HMAC helpers), then use the
   operator-run seed script to create a known challenge without SMS:

   ```bash
   OTP_SEED_CONFIRM=isolated-test \
   OTP_ENVIRONMENT=test \
   FIREBASE_PROJECT_ID=<isolated-test-project> \
   OTP_HASH_PEPPER=<the test secret, supplied locally> \
   OTP_HASH_PEPPER_VERSION=1 \
   OTP_TEST_PHONE=+91XXXXXXXXXX \
   OTP_TEST_CODE=<six digits> \
   node scripts/seed-isolated-test-challenge.mjs
   ```

   The script refuses production/CoolBus/demo projects and does not print the pepper or
   OTP code. It requires Application Default Credentials for Firestore Admin access.

5. A test client calls `verifyOtp` with the printed challenge id, the configured phone and
   code, exchanges the returned custom token with the isolated project's Auth, and confirms
   the Auth UID. A full profile flow is out of scope for the standalone service.
6. Check Firestore `audit_events` and logs: no raw phone, OTP, custom token, HMAC value, or
   credential; challenge consumed; identity link active; `token.issued` present.
7. Verify invalid/expired token behavior in the real isolated Auth project (Phase 3.7);
   the emulator does not validate JWT expiry/signature.
8. Verify fresh-OTP behavior after any post-consumption failure and the documented rate
   limits. Monitor cost exposure (mock SMS has no provider cost; real adapter costs are
   future).

Do not delete Auth users, `identity_links`, `audit_events`, or challenge history during smoke
testing.

## 7. Rollback

- Redeploy the previous Functions revision from a known-good commit/build, or use the
  platform's revision rollback. Do not delete Firestore collections or Auth users.
- Revert `firestore.rules` only by redeploying the previous rules file; do not run destructive
  data cleanup.
- Pepper rotation: add a new Secret Manager version and increment
  `OTP_HASH_PEPPER_VERSION`; old challenges fail closed by version. Do not mutate or delete
  existing `identity_links` or audit records. Auth remains authoritative.
- If a deployment is faulty, disable/roll back the callables first; the service has no
  database schema migration to reverse.

## 8. Remaining decisions/risks

- **D-009:** packaging strategy unresolved; blocks reliable deployment.
- **D-018:** App Check enforcement vs accepted unauthenticated callables with compensating
  controls; enforcement is not implemented/disabled.
- **D-020:** Secret Manager binding implemented; project secret provisioning is an owner
  action.
- **Delivery provider:** only mock exists; no real SMS adapter. The seed script enables
  verification without delivery, but not a real client OTP journey.
- **R1:** global-cap availability; pilot monitoring/abuse drill (Phase 5/7).
- **R2:** requester key is IP+User-Agent; D-018/D-021 decision/enforcement (Phase 3/7).
- **R3:** orphaned pending delivery jobs; Phase 4 reconciliation.
- **R4:** audit-loss alerting; Phase 5/7.
- **R5:** activity-inference residual; monitor.
- **Phase 3.7:** real Auth custom-token exchange and expired-token rejection validation.

Emulator evidence is not production evidence.
