import type { AuditSink, NewAuditEvent } from '../audit/audit-log.js';
import type { Logger } from '../logging.js';

/**
 * Best-effort identity audit writer (Phase 3.1 review F1).
 *
 * A sink failure must never change an identity outcome (resolution, conflict,
 * creation, recovery) or cause a second Auth user to be created. The failure is
 * logged for the D-026 alerting work; the caller continues unchanged.
 */
export async function recordIdentityAudit(
  audit: AuditSink,
  logger: Logger,
  event: NewAuditEvent,
): Promise<void> {
  try {
    await audit.record(event);
  } catch {
    logger.warn('audit.write_failed', { eventType: event.type });
  }
}
