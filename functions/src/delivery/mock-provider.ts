import type {
  DeliveryError,
  DeliveryProvider,
  DeliveryProviderCapabilities,
  DeliveryReceipt,
  DeliveryRequest,
  DeliveryStatus,
} from '@otp-infra/contracts';

const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

export interface MockDeliveryProviderOptions {
  clock?: () => Date;
  failWith?: DeliveryError;
}

export class MockDeliveryProvider implements DeliveryProvider {
  readonly providerId = 'mock';
  readonly capabilities: DeliveryProviderCapabilities = { confirmedDelivery: false };

  private readonly clock: () => Date;
  private readonly failWith?: DeliveryError;
  private readonly recorded: DeliveryRequest[] = [];
  private sequence = 0;

  constructor(options: MockDeliveryProviderOptions = {}) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('MockDeliveryProvider must never be instantiated in production');
    }
    this.clock = options.clock ?? (() => new Date());
    this.failWith = options.failWith;
  }

  get recordedMessages(): readonly DeliveryRequest[] {
    return this.recorded;
  }

  async send(request: DeliveryRequest): Promise<DeliveryReceipt> {
    const now = this.clock();
    const validationError = validateRequest(request, now);
    if (validationError) {
      return this.buildReceipt(request, 'rejected', validationError);
    }
    if (this.failWith) {
      return this.buildReceipt(request, 'failed', this.failWith);
    }
    this.recorded.push(request);
    this.sequence += 1;
    return {
      ...this.buildReceipt(request, 'accepted'),
      providerMessageId: `mock-${this.sequence}`,
    };
  }

  private buildReceipt(
    request: DeliveryRequest,
    status: DeliveryStatus,
    error?: DeliveryError,
  ): DeliveryReceipt {
    const base = {
      jobId: request.jobId,
      providerId: this.providerId,
      status,
      acceptedAt: this.clock().toISOString(),
    };
    return error ? { ...base, error } : base;
  }
}

function validateRequest(request: DeliveryRequest, now: Date): DeliveryError | undefined {
  if (!request.jobId || request.jobId.trim().length === 0) {
    return { code: 'INVALID_REQUEST', message: 'jobId is required', retryable: false };
  }
  if (!E164_PATTERN.test(request.destination)) {
    return {
      code: 'DESTINATION_REJECTED',
      message: 'destination must be a valid E.164 phone number',
      retryable: false,
    };
  }
  if (!request.body || request.body.trim().length === 0) {
    return { code: 'INVALID_REQUEST', message: 'body is required', retryable: false };
  }
  const expiresAt = Date.parse(request.expiresAt);
  if (Number.isNaN(expiresAt)) {
    return {
      code: 'INVALID_REQUEST',
      message: 'expiresAt must be an ISO-8601 timestamp',
      retryable: false,
    };
  }
  if (expiresAt <= now.getTime()) {
    return { code: 'INVALID_REQUEST', message: 'request has already expired', retryable: false };
  }
  return undefined;
}
