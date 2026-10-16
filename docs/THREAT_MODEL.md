# Threat Model

**Status:** Living document. Threat entries are **Proposed** mitigations unless marked
**Confirmed** (implemented and tested in the current repository). Nothing here is a claim
that a control is implemented; Phase acceptance requires test evidence.

**Method:** asset-based analysis with trust boundaries, then a threat table in STRIDE-like
categories with abuse/fraud cases specific to OTP systems (brute force, SMS pumping).

## 1. Assets

| Asset                                        | Why it matters                                                    |
| -------------------------------------------- | ----------------------------------------------------------------- |
| OTP codes                                    | Short-lived authentication secrets; compromise = account takeover |
| Firebase custom tokens                       | Direct session issuance capability                                |
| Firebase Admin credentials / service account | Full control of identity backend                                  |
| Identity links (phone ↔ UID)                 | Account takeover / privacy if leaked or corrupted                 |
| Relay device + SIM + device credential       | Can send SMS; impersonation risks                                 |
| Challenge/job state                          | Integrity-critical; races create bypasses                         |
| Audit logs                                   | Investigation value; must not become a PII leak                   |
| Provider secrets (future)                    | Billing fraud, message spoofing                                   |
| Cost budget                                  | SMS pumping converts abuse directly into money                    |

## 2. Actors

- Legitimate user (own phone).
- Attacker with a phone number they control (enumeration, pumping, mass registration).
- Attacker without the target phone (guessing, replay, race, relay compromise).
- Malicious/compromised relay device operator.
- Curious insider / leaked logs.
- External attacker against endpoints (DoS, credential stuffing).

## 3. Trust boundaries

1. **Client → backend.** All client input untrusted (phone, code, challenge id, UID
   claims). Backend re-validates everything; client UIDs are never used for resolution.
2. **Backend → provider.** Provider sees message content for routed jobs only. Relay is
   semi-trusted: it must not be able to verify OTPs or mint tokens, and its compromise must
   not expose challenges it did not receive.
3. **Backend → Firebase Auth.** Only backend mints custom tokens; Admin credentials exist
   only in backend runtime secrets.
4. **Relay device → backend.** Authenticated, enrolled, revocable; jobs claimed once with
   leases.
5. **Operator → infrastructure.** Audited, least privilege.
6. **Local dev → anything real.** Emulator `demo-` projects only; production access is an
   approval-gated action.

## 4. Threats and mitigations

| ID  | Category               | Threat                                                | Mitigation (Proposed unless noted)                                                                                                                                      | Phase | Status              |
| --- | ---------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------- |
| T1  | Spoofing               | Attacker guesses OTP by brute force                   | CSPRNG codes, attempt limit, lock challenge, per-phone and per-IP throttles, server-side verification                                                                   | 2     | Proposed            |
| T2  | Tampering              | Replay of a previously valid OTP                      | Single-use atomic consumption; consumed challenges reject further attempts                                                                                              | 2     | Proposed            |
| T3  | Tampering              | Concurrent verification race (two requests, one code) | Firestore transaction decides winner; loser gets generic failure                                                                                                        | 2     | Proposed            |
| T4  | Information disclosure | Account enumeration via request/verify responses      | Identical response shape/timing profile regardless of account existence; no distinct "user not found"                                                                   | 2     | Proposed            |
| T5  | Information disclosure | OTP exposed in logs/database                          | Never log codes; store keyed hash (HMAC + versioned pepper); audit events exclude secrets                                                                               | 2     | Proposed            |
| T6  | Elevation              | Client supplies a UID to mint a session               | UID never accepted from client; resolution from verified challenge only                                                                                                 | 3     | Proposed            |
| T7  | Spoofing               | Forged/duplicated custom tokens                       | Tokens short-lived, minted server-side after verified challenge; Admin creds protected                                                                                  | 3     | Proposed            |
| T8  | Spoofing               | Fake relay device enrolls or replays jobs             | Enrolled revocable credentials (hashed at rest); one-time leases; job expiry; replay-safe result reporting                                                              | 4     | Proposed            |
| T9  | Info disclosure        | Compromised relay reads other users' OTPs             | Job scoping (only routed jobs), revocation, health monitoring; relay never sees challenges, only messages it must send                                                  | 4     | Proposed            |
| T10 | DoS                    | Request flooding / verify flooding                    | Server-side rate limits with retry-after; global caps; fail-closed for new challenges                                                                                   | 2     | Proposed            |
| T11 | Fraud                  | SMS pumping (many costly messages to premium ranges)  | Per-phone/IP/global send caps, destination classification, monitoring, provider spend caps                                                                              | 2/7   | Proposed            |
| T12 | Tampering              | Challenge/job collection manipulated by client        | Firestore rules deny all client access; Admin SDK only                                                                                                                  | 2     | Proposed            |
| T13 | Repudiation            | No record of security-relevant actions                | Audit events with outcome codes (no PII/secrets)                                                                                                                        | 2     | Proposed            |
| T14 | Elevation              | Provider adapter abused to bypass verification        | Contract forbids verification role; backend never accepts provider-declared "verified"; mock guarded against production (**Confirmed** for mock guard and capabilities) | 1/4   | Partially confirmed |
| T15 | Info disclosure        | Secrets (pepper, credentials) in repo or client       | `.gitignore`, `.env.example` placeholders only (**Confirmed**); Secret Manager at deploy time                                                                           | 1/2/7 | Partially confirmed |
| T16 | Tampering              | Duplicate identity creation / wrong account link      | Identity links are backend-owned; conflict → safe rejection; explicit Phase 3 tests                                                                                     | 3     | Proposed            |
| T17 | Info disclosure        | Enumeration through timing differences                | Keep verification cost roughly constant; document residual risk; measure in Phase 5                                                                                     | 5     | Unverified          |
| T18 | Elevation              | Insider access to collections/console                 | Least privilege IAM, audit trail, environment separation                                                                                                                | 7     | Proposed            |
| T19 | Fraud                  | Attacker with relay SIM uses it outside service       | Device credential revocation; ops runbook; SIM is dedicated                                                                                                             | 4/5   | Proposed            |

## 5. Explicitly out of scope (current phases)

- Nation-state/telecom-level interception of SMS (inherent SMS limitation; documented, not
  solved).
- Compromise of the Firebase/Google platform itself.
- Client device malware with full app control (mitigated only by short OTP TTL and
  single use).

## 6. Abuse-case walkthroughs (to become Phase 2 tests)

1. **Guess loop:** attacker submits many wrong codes → attempts exhausted → challenge
   locked; further attempts return generic failure; rate limiter throttles new challenges.
2. **Race:** two parallel correct-code submissions → exactly one `consumed`; the loser sees
   the same invalid outcome as a wrong code.
3. **Late replay:** correct code after expiry → rejected as expired/invalid.
4. **Enumeration:** request/verify for unknown vs known phones → indistinguishable
   responses.
5. **Flood:** sustained request flood → throttled with retry-after; no OTP volume growth.
6. **Relay replay:** same job claimed twice → single lease; duplicate reports idempotent.

## 7. Residual risk register

- Emulator/demo behavior may differ from real Firebase/Auth behavior (R8 in roadmap).
- SMS as a channel is inherently interceptable at the network layer (accepted, documented).
- Timing uniformity (T17) is best-effort until measured.

## 8. Change control

Any new component (provider adapter, relay endpoint, admin tooling) requires: new boundary
analysis here, threat entries, and Phase tests before its phase can complete. If a design
flaw is found, stop and propose a documented revision (see `docs/DECISIONS.md`).
