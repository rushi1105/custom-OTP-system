/**
 * Delivery-provider contract.
 *
 * The OTP engine and identity layers depend only on this interface, never on a
 * concrete provider implementation. Providers progress from mock -> Android
 * relay -> commercial SMS provider without changing callers.
 *
 * Status: Proposed (defined in Phase 1; not yet exercised against a real provider).
 */

export type DeliveryChannel = 'sms';

export type DeliveryStatus =
  /** The provider durably accepted the job. This does NOT mean the message was delivered. */
  | 'accepted'
  /** The provider refused the job; retrying the same request is pointless. */
  | 'rejected'
  /** A transient or provider-side failure occurred; the job may be retried per policy. */
  | 'failed';

export type DeliveryErrorCode =
  | 'INVALID_REQUEST'
  | 'DESTINATION_REJECTED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_AUTH_FAILED'
  | 'UNKNOWN';

export interface DeliveryError {
  readonly code: DeliveryErrorCode;
  readonly message: string;
  /** Whether the caller may retry the same job (with backoff) without duplication risk. */
  readonly retryable: boolean;
}

export interface DeliveryRequest {
  /** Unique job identifier. Providers must treat repeated sends of the same jobId as idempotent. */
  readonly jobId: string;
  readonly channel: DeliveryChannel;
  /** Destination phone number in E.164 format. Validated by the backend before delivery. */
  readonly destination: string;
  /** Message body. Contains the OTP during normal operation; never logged by providers. */
  readonly body: string;
  /** ISO-8601 UTC expiry. Providers must reject requests whose expiry has passed. */
  readonly expiresAt: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface DeliveryReceipt {
  readonly jobId: string;
  readonly providerId: string;
  readonly status: DeliveryStatus;
  /** Provider-side message identifier. Only set when the provider assigned one. */
  readonly providerMessageId?: string;
  /** ISO-8601 UTC time at which the provider produced this receipt. */
  readonly acceptedAt: string;
  readonly error?: DeliveryError;
}

export interface DeliveryProviderCapabilities {
  /**
   * Whether this provider can report confirmed handset delivery (not just carrier acceptance).
   * The mock provider and the Android relay cannot; they must report false.
   */
  readonly confirmedDelivery: boolean;
}

export interface DeliveryProvider {
  readonly providerId: string;
  readonly capabilities: DeliveryProviderCapabilities;
  send(request: DeliveryRequest): Promise<DeliveryReceipt>;
}
