# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-17

### Added

- Phase 2 secure OTP engine (`functions/src/otp/`): CSPRNG OTP/challenge/salt generation,
  E.164 phone normalization, keyed HMAC-SHA256 storage with versioned pepper, challenge
  state machine (pending/consumed/expired/locked/void), expiry, attempt limits, resend
  cooldown, atomic single-use consumption, replay protection.
- Server-side rate limiting in Firestore transactions: per-phone, per-requester request
  windows, per-requester verification window, global per-minute cap.
- Firestore transaction abstraction (`functions/src/storage/`) with a 20-attempt retry
  budget; delivery runs outside transactions to avoid duplicate sends on retry.
- Delivery dispatcher and provider factory (`functions/src/delivery/`): mock provider only,
  fail-fast on unknown providers and production mock usage; explicit delivery-failure
  semantics (challenge voided, cooldown cleared, `SERVICE_UNAVAILABLE`).
- Callable API `requestOtp` / `verifyOtp` (`functions/src/api/`) with enumeration-resistant
  responses and stable error codes mapped through `HttpsError` details.
- Privacy-preserving audit events (`functions/src/audit/`) and structured logging without
  OTPs or phone numbers.
- `firestore.rules` denying all client access, plus environment configuration
  (`functions/src/config/`) with fail-fast pepper validation.
- Tests: 85 unit tests and 18 Firestore-emulator integration/security tests, including
  concurrent verification (10-way race), concurrent duplicate requests, expiry/lock/replay
  suites, rate-limit suites, secret-leak assertions, static CSPRNG checks, and rules-denial
  tests for unauthenticated and authenticated contexts.
- `vitest.integration.mts`, `test:integration` script (offline `demo-` emulator), ESLint
  bans for the JavaScript PRNG and non-keyed hashing in production source.

### Changed

- `MockDeliveryProvider` gained `rejectWith` and `throwWith` test options.
- CI workflow runs the Firestore-emulator integration/security suite with emulator caching.

## [0.1.0] - 2026-10-17

### Added

- Phase 1 repository foundation (see `docs/OTP_INFRASTRUCTURE_MASTER_ROADMAP.md`).
- Master roadmap documenting all seven project phases.
- Architecture, threat model, data model, API contract, and decision log documents.
- npm workspaces monorepo with `functions` (Cloud Functions v2, TypeScript) and
  `packages/contracts` (delivery-provider contract types).
- Minimal `health` Cloud Function and pure handler.
- `MockDeliveryProvider` implementing the delivery contract, guarded against production use.
- Vitest unit tests for the health handler and the mock provider contract.
- ESLint (flat config), Prettier, strict TypeScript configuration, and GitHub Actions CI.
- `firebase.json` with offline emulator configuration for a `demo-` project.

[Unreleased]: https://example.invalid/otp-infrastructure-service/compare/v0.1.0...HEAD
[0.1.0]: https://example.invalid/otp-infrastructure-service/releases/tag/v0.1.0
