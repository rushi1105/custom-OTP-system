/** Provider-agnostic custom-token issuance port (Phase 3.4). */
export interface CustomTokenIssuer {
  /** Mints a Firebase custom token for exactly this UID; no custom claims. */
  createCustomToken(uid: string): Promise<string>;
}
