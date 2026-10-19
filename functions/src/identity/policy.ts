/** Identity policy constants (docs/IDENTITY_DESIGN.md §4.3, §8). */

/** Creation-claim lifetime; short enough to recover, long enough for cold starts. */
export const IDENTITY_CLAIM_TTL_SECONDS = 120;

/** Bounded retry budget while another resolution holds an active claim. */
export const IDENTITY_CLAIM_RETRY_ATTEMPTS = 3;

/** Backoff between claim retries (milliseconds). */
export const IDENTITY_CLAIM_RETRY_BACKOFF_MS = 150;

/**
 * Retention mirror for identity-link records. Links are long-lived cache
 * records, never TTL-deleted in Phase 3; retention policy is revisited in
 * Phase 5 (compliance review).
 */
export const IDENTITY_LINK_TTL_SECONDS = 2 * 365 * 24 * 60 * 60;
