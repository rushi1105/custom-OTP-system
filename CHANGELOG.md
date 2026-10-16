# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
