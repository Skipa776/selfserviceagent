// The composition root — the ONE place implementations are chosen
// (contracts/adapters.md, components/mock_adapters.md).
//
// This file plus the parser module is the entire difference between stage 1 and
// stage 2. Nothing above this layer imports an implementation: the orchestrator
// takes interfaces, so swapping TicketSink for a ServiceNow PDI here changes no
// caller. That claim is the single strongest talking point in the project, and
// this file is where it is either true or a slogan.

import { randomUUID } from 'node:crypto';

import {
  InMemoryIdentityContext,
  InMemoryIncidentSource,
  InMemoryMatchFeedbackSink,
  InMemoryRateLimiter,
  InMemoryReportStream,
  InMemoryTicketSink,
  UnwiredStatusReader,
  type Clock,
} from './adapters/memory';
import { CompositeIncidentSource } from './adapters/composite';
import {
  ServiceNowIncidentSource,
  ServiceNowTicketSink,
  snowConfigFromEnv,
  type Fetch,
  type SnowConfig,
} from './adapters/servicenow';
import { AuditLog, type AuditLine } from './audit';
import { configureGate, type GateTuning } from './clusterGate';
import { llmClientFromEnv, type ChatClient } from './parser/chatClient';
import { createLlmParser } from './parser/llmParser';
import { parseReport } from './parser/reportParser';
import { PatternDetector } from './patternDetector';
import { InMemoryIdempotencyStore, type OrchestratorDeps } from './orchestrator';
import { configureThrottle, type ThrottleLimits } from './throttleLimits';

// ── The injected placeholders ─────────────────────────────────────────────────
// These are the UNSET constants, and they live HERE rather than in source
// precisely so that reading this file tells you they were chosen for a demo and
// not measured. cluster_gate.md and report_throttle.md both require the injection
// to be "clearly labelled"; this is that label.
//
//   !! NONE OF THESE FIVE NUMBERS IS EVIDENCE-BACKED. !!
//   Shipping any of them to production without the measurement that resolves it
//   without measurement would turn demo placeholders into accidental policy.

/** DEMO VALUES — cluster_gate.md's two UNSET constants. */
export const DEMO_GATE: GateTuning = {
  // Chosen so the mock scorer's "full agreement" (1.0) matches and its "location
  // disagreement" (0) does not. It is a separator for fixtures, not a threshold.
  matchScoreThreshold: 0.6,
  // Two hours. Resolving this needs the real distribution of "user notices" minus
  // "incident opened", which does not exist yet.
  matchTimeWindowMinutes: 120,
};

/** DEMO VALUES — report_throttle.md's three UNSET limits. */
export const DEMO_THROTTLE: ThrottleLimits = {
  windowMinutes: 60,
  // Deliberately loose: nobody has measured how often a legitimate user reports a
  // problem, and a demo that throttles the presenter is worse than one that does
  // not demonstrate the ceiling.
  maxReportsPerIdentity: 20,
  maxDistinctServicesPerWindow: 5,
};

export type System = {
  readonly deps: OrchestratorDeps;
  readonly incidents: InMemoryIncidentSource;
  readonly tickets: InMemoryTicketSink;
  readonly stream: InMemoryReportStream;
  readonly detector: PatternDetector;
  readonly audit: AuditLog;
  /**
   * Drain published events into the detector. Called AFTER a response is
   * returned, never before — the detector's availability is not a dependency of
   * answering anyone (pattern_detector.md).
   */
  drainToDetector(): ReturnType<PatternDetector['consume']>[];
};

/** Kept so existing callers (demo/, tests/) do not have to change. */
export type Stage1System = System;

export type BuildOptions = {
  clock?: Clock;
  auditSink?: (line: AuditLine) => void;
};

/**
 * Everything both stages share — which, by design, is everything except the
 * parser and the stage number. The two public builders below differ by those two
 * arguments and nothing else; that is the composition-root half of the stage-2
 * claim, and writing it as one function rather than two copies is what keeps it
 * literally true instead of true-until-someone-edits-one-of-them.
 */
function build(
  stage: 1 | 2,
  makeParser: (clock: Clock) => OrchestratorDeps['parser'],
  options?: BuildOptions,
  snow?: SnowWiring | null,
): System {
  const clock: Clock = options?.clock ?? ((): Date => new Date());

  // The two injections. Doing them here, once, is why source ships no defaults.
  configureGate(DEMO_GATE);
  configureThrottle(DEMO_THROTTLE);

  const incidents = new InMemoryIncidentSource();
  const tickets = new InMemoryTicketSink();
  const stream = new InMemoryReportStream();
  const feedback = new InMemoryMatchFeedbackSink();
  const audit = new AuditLog(options?.auditSink);
  const detector = new PatternDetector(clock);

  // Present, deliberately NOT passed to the orchestrator: StatusReader is stage 3
  // (mock_adapters.md). Constructed here so the unwired seam is visible rather
  // than merely absent.
  void new UnwiredStatusReader();

  const deps: OrchestratorDeps = {
    // THE STAGE SEAM — the only argument that differs between the two builders.
    parser: makeParser(clock),
    // THE ADAPTER SEAM. Unconfigured, both stay in-memory and stage 2 is stage 1
    // with a different parser. Configured, tickets are filed into a real
    // ServiceNow PDI and peer tickets are read back out of it — while declared
    // incidents stay fixtures, because no read-only real feed is confirmed
    // until an authoritative feed is confirmed. That asymmetry is why the
    // composite exists rather than a straight swap.
    incidents:
      snow == null
        ? incidents
        : new CompositeIncidentSource([
            incidents,
            new ServiceNowIncidentSource(snow.config, snow.fetchImpl),
          ]),
    tickets: snow == null ? tickets : new ServiceNowTicketSink(snow.config, snow.fetchImpl),
    stream,
    feedback,
    identity: new InMemoryIdentityContext(),
    limiter: new InMemoryRateLimiter(clock),
    idempotency: new InMemoryIdempotencyStore(),
    audit,
    clock,
    newCorrelationId: () => randomUUID(),
    stage,
  };

  let drained = 0;
  return {
    deps,
    incidents,
    tickets,
    stream,
    detector,
    audit,
    drainToDetector() {
      const fresh = stream.events.slice(drained);
      drained = stream.events.length;
      return fresh.map((e) => detector.consume(e));
    },
  };
}

/** The keyword parser, wrapped in the seam's shape. Stage 1, and every fallback. */
const keywordParser: OrchestratorDeps['parser'] = {
  parse: async (text) => ({ report: parseReport(text), source: 'keyword' }),
};

/** Stage 1 — deterministic demo. No credential, no network, no model. */
export function buildStage1(options?: BuildOptions): System {
  return build(1, () => keywordParser, options);
}

/** How stage 2 reaches a ServiceNow PDI. `fetchImpl` is injected by tests. */
export type SnowWiring = { config: SnowConfig; fetchImpl?: Fetch };

/**
 * Stage 2 — AI-capable, contained. Identical to stage 1 in every respect except
 * the parser. Compare the two function bodies: that comparison IS the board demo.
 *
 * `client` is injected so tests can wire a recorded-response fake
 * so automated tests never touch a live API. Left undefined, it reads the
 * environment.
 *
 * **A null client is not an error.** Unconfigured — no key, or the key pulled
 * mid-run — wires the keyword parser and the service keeps answering at stage-1
 * quality. That is error_rescue_map.md `llm_unavailable` arriving before the
 * first request instead of during one, and it is the same degradation either way.
 * It is not silent: every audit line reads `parseSource: 'keyword'`, which is the
 * signal audit_log.md exists to give (a stage-2 run whose log says 'keyword'
 * throughout is a run with no working API key).
 *
 * **A null `snow` is likewise not an error**, but it is less visible than a null
 * client, and that asymmetry is worth knowing: an unconfigured PDI files into the
 * in-memory sink, which returns realistic-looking numbers. Nothing in the reply
 * distinguishes that from a real filing. The audit log records `stage: 2` either
 * way. Before showing anyone real records, confirm they exist in the instance —
 * that is what `npm run snow:check` is for.
 */
export function buildStage2(
  options?: BuildOptions & { client?: ChatClient | null; snow?: SnowWiring | null },
): System {
  const client = options?.client === undefined ? llmClientFromEnv() : options.client;

  const config = snowConfigFromEnv();
  const snow =
    options?.snow === undefined ? (config === null ? null : { config }) : options.snow;

  return build(
    2,
    (clock) => (client === null ? keywordParser : createLlmParser({ client, now: clock })),
    options,
    snow,
  );
}
