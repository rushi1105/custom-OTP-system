import { IdentityCreationService } from '../../functions/src/identity/creation.js';
import { IdentityResolver } from '../../functions/src/identity/resolver.js';
import { TEST_PEPPER, TEST_PEPPER_VERSION, TEST_START_ISO } from './engine-fixture.js';
import { FixedClock } from './fixed-clock.js';
import { FakeAuthPort, InMemoryIdentityStore } from './identity-fakes.js';
import { RecordingAuditSink } from './recording-audit-sink.js';
import { RecordingLogger } from './recording-logger.js';

export interface CreationFixture {
  readonly creation: IdentityCreationService;
  readonly resolver: IdentityResolver;
  readonly store: InMemoryIdentityStore;
  readonly auth: FakeAuthPort;
  readonly clock: FixedClock;
  readonly logger: RecordingLogger;
  readonly audit: RecordingAuditSink;
  readonly sleepCalls: number[];
  readonly pepper: string;
  readonly pepperVersion: number;
}

/** Deterministic fixture for the creation orchestration (no Firebase, no timers). */
export function createCreationFixture(options?: {
  readonly startIso?: string;
  readonly pepper?: string;
  readonly pepperVersion?: number;
}): CreationFixture {
  const clock = new FixedClock(options?.startIso ?? TEST_START_ISO);
  const store = new InMemoryIdentityStore();
  const auth = new FakeAuthPort();
  const logger = new RecordingLogger();
  const audit = new RecordingAuditSink();
  const sleepCalls: number[] = [];
  const pepper = options?.pepper ?? TEST_PEPPER;
  const pepperVersion = options?.pepperVersion ?? TEST_PEPPER_VERSION;

  const resolver = new IdentityResolver({
    store,
    auth,
    clock: () => clock.now(),
    logger,
    audit,
    pepper,
    pepperVersion,
  });

  const creation = new IdentityCreationService({
    resolver,
    store,
    auth,
    clock: () => clock.now(),
    logger,
    audit,
    pepper,
    pepperVersion,
    sleep: async (milliseconds) => {
      sleepCalls.push(milliseconds);
    },
  });

  return {
    creation,
    resolver,
    store,
    auth,
    clock,
    logger,
    audit,
    sleepCalls,
    pepper,
    pepperVersion,
  };
}
