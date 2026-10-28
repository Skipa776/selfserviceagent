// Shared stage-1 wiring for the orchestrator suites. Not a test file — it is the
// in-memory composition root the flow, error-map and throttle suites all build on,
// so those suites assert behaviour rather than each re-wiring seven adapters.

import {
  InMemoryIdentityContext,
  InMemoryIncidentSource,
  InMemoryMatchFeedbackSink,
  InMemoryRateLimiter,
  InMemoryReportStream,
  InMemoryTicketSink,
  type Clock,
} from '../src/adapters/memory';
import { AuditLog } from '../src/audit';
import type { ProblemReport } from '../src/contracts/types';
import { InMemoryIdempotencyStore, type OrchestratorDeps } from '../src/orchestrator';
import { CORPUS_NOW } from './corpus';

/**
 * Injected per test — source ships no default for either (cluster_gate.md).
 * Corpus candidates score exactly 1.0 (full agreement) or 0 (location
 * disagreement), so any threshold in (0, 1] classifies them identically.
 */
export const TEST_GATE = { matchScoreThreshold: 0.6, matchTimeWindowMinutes: 120 } as const;

/** Generous enough that nothing is throttled unless a test means it to be. */
export const TEST_THROTTLE = {
  windowMinutes: 60,
  maxReportsPerIdentity: 10,
  maxDistinctServicesPerWindow: 5,
} as const;

export const IDENTITY_REF = 'synthetic-session-1';

/** A clock the test can wind forward — window rollover without waiting. */
export function mutableClock(start = CORPUS_NOW): { clock: Clock; advanceMinutes: (m: number) => void } {
  let at = Date.parse(start);
  return {
    clock: () => new Date(at),
    advanceMinutes: (m: number) => {
      at += m * 60_000;
    },
  };
}

export type Harness = {
  deps: OrchestratorDeps;
  incidents: InMemoryIncidentSource;
  tickets: InMemoryTicketSink;
  stream: InMemoryReportStream;
  feedback: InMemoryMatchFeedbackSink;
  identity: InMemoryIdentityContext;
  limiter: InMemoryRateLimiter;
  audit: AuditLog;
};

export function harness(report: ProblemReport, clock: Clock = () => new Date(CORPUS_NOW)): Harness {
  const incidents = new InMemoryIncidentSource();
  const tickets = new InMemoryTicketSink();
  const stream = new InMemoryReportStream();
  const feedback = new InMemoryMatchFeedbackSink();
  const identity = new InMemoryIdentityContext();
  const limiter = new InMemoryRateLimiter(clock);
  const audit = new AuditLog();

  let n = 0;
  const deps: OrchestratorDeps = {
    // THE STAGE SEAM, stubbed to the fixture record: flow scenarios measure the
    // code, not the parser (report_corpus.md).
    parser: { parse: async () => ({ report, source: 'keyword' }) },
    incidents,
    tickets,
    stream,
    feedback,
    identity,
    limiter,
    idempotency: new InMemoryIdempotencyStore(),
    audit,
    clock,
    newCorrelationId: () => `corr-${++n}`,
    stage: 1,
  };

  return { deps, incidents, tickets, stream, feedback, identity, limiter, audit };
}
