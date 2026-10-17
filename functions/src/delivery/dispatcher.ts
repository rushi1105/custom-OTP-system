import type { DeliveryProvider, DeliveryReceipt, DeliveryRequest } from '@otp-infra/contracts';

import type { Logger } from '../logging.js';
import type { DeliveryJobRecord, DeliveryJobStatus } from '../otp/types.js';
import { COLLECTIONS, docRef, type DocumentDatabase } from '../storage/types.js';

export interface Dispatcher {
  readonly providerId: string;
  dispatch(job: DeliveryJobRecord, request: DeliveryRequest): Promise<DeliveryReceipt>;
}

/**
 * Executes a delivery attempt through the configured provider and records the
 * receipt on the job document.
 *
 * Delivery runs outside the challenge transaction on purpose: Firestore
 * transactions may retry, and provider sends are external side effects that
 * must not be duplicated by a transaction retry.
 *
 * Phase 2 semantics: a job that was not accepted by the provider is not
 * retried automatically. The engine voids the owning challenge and reports
 * `delivery_unavailable` so the client can retry explicitly.
 */
export class ProviderDeliveryDispatcher implements Dispatcher {
  readonly providerId: string;

  private readonly provider: DeliveryProvider;
  private readonly db: DocumentDatabase;
  private readonly logger: Logger;
  private readonly clock: () => Date;

  constructor(provider: DeliveryProvider, db: DocumentDatabase, logger: Logger, clock: () => Date) {
    this.provider = provider;
    this.providerId = provider.providerId;
    this.db = db;
    this.logger = logger;
    this.clock = clock;
  }

  async dispatch(job: DeliveryJobRecord, request: DeliveryRequest): Promise<DeliveryReceipt> {
    let receipt: DeliveryReceipt;
    try {
      receipt = await this.provider.send(request);
    } catch {
      receipt = {
        jobId: job.jobId,
        providerId: this.providerId,
        status: 'failed',
        acceptedAt: this.clock().toISOString(),
        error: {
          code: 'PROVIDER_UNAVAILABLE',
          message: 'delivery provider failed unexpectedly',
          retryable: true,
        },
      };
    }

    const updated: DeliveryJobRecord = {
      ...job,
      status: mapReceiptStatus(receipt.status),
      attempts: job.attempts + 1,
      updatedAt: this.clock().toISOString(),
      receipt: {
        ...(receipt.providerMessageId !== undefined
          ? { providerMessageId: receipt.providerMessageId }
          : {}),
        reportedAt: receipt.acceptedAt,
        ...(receipt.error !== undefined
          ? { errorCode: receipt.error.code, retryable: receipt.error.retryable }
          : {}),
      },
    };

    try {
      await this.db.set(docRef(COLLECTIONS.deliveryJobs, job.jobId), updated);
    } catch {
      this.logger.warn('delivery.receipt_write_failed', {
        jobId: job.jobId,
        status: updated.status,
      });
    }

    return receipt;
  }
}

function mapReceiptStatus(status: DeliveryReceipt['status']): DeliveryJobStatus {
  if (status === 'accepted') {
    return 'accepted';
  }
  return status === 'rejected' ? 'rejected' : 'failed';
}
