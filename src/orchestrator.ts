// Orchestrator — one request's lifecycle (components/orchestrator.md).
//
// This is the stage-1 request sequence the manager is actually watching run.
//
// It is the only place the parser, the incident source, decide(), the ticket
// sink and the report stream are wired together, and nothing else calls
// decide(). There is NO conversation state here — callers own the dialogue, and
// each request either completes or asks for exactly one more detail.
//
// The clock is read ONCE, at the top, and passed onward as booleans and counts.
// That is what keeps decide() pure: by the time evidence reaches it there is no
// timestamp in scope to re-derive, no summary to quote, and no adapter to call.

import { createHash } from 'node:crypto';

import type { Clock } from './adapters/memory';
import { AmbiguousCreateError } from './adapters/memory';
import { AuditLog, type AuditLine } from './audit';
import { CLUSTER_THRESHOLD, gateTuning, thresholdFor, type GateTuning } from './clusterGate';
import { compose } from './composer';
import type {
  IdentityContext,
  IncidentSource,
  MatchFeedbackSink,
  ReportRateLimiter,
  ReportStream,
  TicketSink,
} from './contracts/adapters';
import type { ReportRequest, ReportResponse } from './contracts/api';
import type {
  DeclaredIncident,
  MatchCandidate,
  PeerTicket,
  ProblemReport,
  TicketPayload,
} from './contracts/types';
import { decide, type Evidence } from './decide';
import { throttleLimits } from './throttleLimits';
import type { TicketScope } from './vocab/catalog';

/**
 * What one parse produced, and how. `source` is per-CALL, not a property of the
 * parser: the stage-2 LLM parser is wired as `source: 'llm'` but returns
 * `'keyword'` on the calls where the API failed and it fell back
 * (error_rescue_map.md `llm_unavailable` / `llm_unparseable`). A static field on
 * the parser cannot express that, and the audit line has to be able to
 * (audit_log.md — `parseSource` is how a post-swap quality regression becomes
 * visible; a field that always reads 'llm' makes the fallback invisible, which
 * is the one thing the field exists to prevent).
 */
export type ParseResult = {
  readonly report: ProblemReport;
  readonly source: 'keyword' | 'llm';
  /** Only meaningful when the LLM ran. Undefined at stage 1 — there is no repair. */
  readonly repairAttempted?: boolean;
};

/**
 * THE STAGE SEAM, expressed as one injected object. Stage 1 wires the keyword
 * extractor; stage 2 wires the LLM parser behind this identical shape and steps
 * 2–11 below are untouched. If a stage-2 build produces a diff in this file, the
 * seam was drawn in the wrong place (orchestrator.md, "# Stages").
 *
 * `Promise` even though stage 1 needs none: the parser is the one dependency
 * that becomes a network call at stage 2, and a synchronous signature here would
 * force the swap to edit this file — the exact widening the seam exists to
 * prevent. Fixing the seam is cheap; fixing the caller is the failure
 * so parser changes do not force caller changes.
 */
export type Parser = {
  parse(text: string): Promise<ParseResult>;
};

/** Prior results, keyed on report content. Retention = the throttle window. */
export type IdempotencyStore = {
  get(key: string, now: Date): ReportResponse | null;
  set(key: string, response: ReportResponse, now: Date): void;
};

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly seen = new Map<string, { at: number; response: ReportResponse }>();

  get(key: string, now: Date): ReportResponse | null {
    const entry = this.seen.get(key);
    if (entry === undefined) return null;
    // One duration, one place: reusing the throttle window means there is no
    // second timer that can drift out of sync (orchestrator.md).
    const cutoff = now.getTime() - throttleLimits().windowMinutes * 60_000;
    if (entry.at <= cutoff) {
      this.seen.delete(key);
      return null;
    }
    return entry.response;
  }

  set(key: string, response: ReportResponse, now: Date): void {
    this.seen.set(key, { at: now.getTime(), response });
  }
}

export type OrchestratorDeps = {
  readonly parser: Parser;
  readonly incidents: IncidentSource;
  readonly tickets: TicketSink;
  readonly stream: ReportStream;
  readonly feedback: MatchFeedbackSink;
  readonly identity: IdentityContext;
  readonly limiter: ReportRateLimiter;
  readonly idempotency: IdempotencyStore;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly newCorrelationId: () => string;
  readonly stage: 1 | 2 | 3;
};

const inFlightByStore = new WeakMap<IdempotencyStore, Map<string, Promise<ReportResponse>>>();

function coordinateInFlight(
  store: IdempotencyStore,
  key: string,
  start: () => Promise<ReportResponse>,
): Promise<ReportResponse> {
  let requests = inFlightByStore.get(store);
  if (requests === undefined) {
    requests = new Map();
    inFlightByStore.set(store, requests);
  }

  const active = requests.get(key);
  if (active !== undefined) return active;

  const coordinated = start().finally(() => {
    if (requests.get(key) === coordinated) requests.delete(key);
    if (requests.size === 0) inFlightByStore.delete(store);
  });
  requests.set(key, coordinated);
  return coordinated;
}

// ── Step 4: idempotency key ───────────────────────────────────────────────────

/**
 * Keyed on report CONTENT, never on a session or turn id. Callers retry, re-plan
 * and double-submit invisibly, so content is the only stable handle this service
 * holds. The honest consequence: someone who genuinely reports the same problem
 * twice gets the first ticket back rather than a second one — which is correct
 * behaviour anyway.
 */
export function idempotencyKey(reporterHash: string, r: ProblemReport): string {
  const normalizedVerbatim = r.verbatim.trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash('sha256')
    .update([reporterHash, r.service, r.scope, r.location, r.building, r.room, normalizedVerbatim].join(':'))
    .digest('hex');
}

// ── Step 5: completeness gate ─────────────────────────────────────────────────

/**
 * Required before search. `symptom === 'unknown'` never blocks: it weakens
 * matching, and asking someone to classify their own symptom to satisfy an enum
 * is worse service than a weaker search.
 */
export function missingFields(r: ProblemReport): string[] {
  const missing: string[] = [];
  if (r.service === 'unknown') missing.push('service');
  if (r.scope === 'unknown') missing.push('scope');
  if (r.scope === 'location' && r.location === '') missing.push('location');
  return missing;
}

// ── Step 7: reduce ────────────────────────────────────────────────────────────

function isWithinWindow(openedAt: string, now: Date, windowMinutes: number): boolean {
  const opened = Date.parse(openedAt);
  if (Number.isNaN(opened)) return false;
  const ageMs = now.getTime() - opened;
  return ageMs >= 0 && ageMs <= windowMinutes * 60_000;
}

/**
 * Trust boundary on adapter output, exactly like normalize() is on parser output
 * (error_rescue_map.md `incident_source_malformed`). Discard the bad record,
 * proceed with the rest, and NEVER synthesize the missing field — a fabricated
 * status is the one thing worse than a missing one.
 */
function isWellFormed(c: MatchCandidate): boolean {
  const r = c as unknown as Record<string, unknown>;
  const required = ['id', 'service', 'scope', 'symptom', 'openedAt', 'url'];
  if (!required.every((k) => typeof r[k] === 'string' && r[k] !== '')) return false;
  if (!Array.isArray(r.locations)) return false;
  if (typeof r.matchScore !== 'number' || typeof r.reporterHash !== 'string') return false;

  if (c.kind === 'declared_incident') {
    return ['status', 'statusUpdatedAt', 'summary'].every((k) => typeof r[k] === 'string');
  }
  if (c.kind === 'peer_ticket') {
    // A peer ticket carrying authoritative status fields is malformed, not a
    // bonus. Trusting it is one refactor away from telling a user "the service is
    // down" on the strength of a duplicate report (match_candidate.md).
    return r.status === undefined && r.statusUpdatedAt === undefined && r.summary === undefined;
  }
  return false;
}

type Reduced = {
  readonly evidence: Evidence;
  readonly topDeclared: DeclaredIncident | null;
  readonly qualifyingPeers: readonly PeerTicket[];
  readonly topMatchScore: number;
  readonly matchedId: string;
  /** The per-topic deflection ceiling applied to this report (clusterGate.ts).
   *  Logged on the `decided` line so a deflect-at-10 vs deflect-at-5 is visible. */
  readonly clusterThreshold: number;
};

function reduceCandidates(
  report: ProblemReport,
  candidates: readonly MatchCandidate[],
  now: Date,
  tuning: GateTuning,
): Reduced {
  const byScore = [...candidates].sort((a, b) => b.matchScore - a.matchScore);

  const declared = byScore.filter((c): c is DeclaredIncident => c.kind === 'declared_incident');
  const peers = byScore.filter((c): c is PeerTicket => c.kind === 'peer_ticket');

  // The count threshold is per-topic (clusterGate.ts): resolved HERE from the
  // report, then handed to decide() inside evidence — decide() never resolves it
  // itself, keeping it pure and threshold-literal-free.
  const clusterThreshold = thresholdFor(report.service, report.location);

  const topDeclared =
    declared.find(
      (d) =>
        d.matchScore >= tuning.matchScoreThreshold &&
        isWithinWindow(d.openedAt, now, tuning.matchTimeWindowMinutes),
    ) ?? null;
  // Peers that individually match: score AND window, both required. A
  // perfectly-worded match against a ticket resolved yesterday is not a match.
  const qualifyingPeers = peers.filter(
    (p) =>
      p.matchScore >= tuning.matchScoreThreshold &&
      isWithinWindow(p.openedAt, now, tuning.matchTimeWindowMinutes),
  );

  const evidence: Evidence = {
    declared:
      topDeclared === null
        ? null
        : {
            matchScore: topDeclared.matchScore,
            withinWindow: true,
          },
    peers:
      qualifyingPeers.length === 0
        ? null
        : {
            matchScore: qualifyingPeers[0].matchScore,
            withinWindow: true,
            // DISTINCT reporters, de-duplicated by hash before decide() ever sees
            // it — five tickets from one person is one reporter (boundaries.md).
            distinctReporters: new Set(qualifyingPeers.map((p) => p.reporterHash)).size,
            clusterThreshold,
          },
  };

  return {
    evidence,
    topDeclared,
    qualifyingPeers,
    topMatchScore: byScore[0]?.matchScore ?? 0,
    matchedId: '',
    clusterThreshold,
  };
}

// ── Step 9: the payload ───────────────────────────────────────────────────────

function buildDescription(r: ProblemReport, reporterName: string, namedInBody: boolean): string {
  // Composed by CODE, never authored by a model. The model's only contribution to
  // a ticket body is the reporter's own quoted words — quoted exactly once.
  const lines = [
    "Reporter's own words:",
    `"${r.verbatim}"`,
    '',
    `Service: ${r.service}`,
    `Scope: ${r.scope}`,
    `Location: ${r.location === '' ? 'not applicable' : r.location}`,
    `Building: ${r.building === '' ? 'not applicable' : r.building}`,
    `Room: ${r.room === '' ? 'not applicable' : r.room}`,
    `Symptom: ${r.symptom}`,
    `Observed: ${r.observedAt === '' ? 'not stated by the reporter' : r.observedAt}`,
  ];
  if (namedInBody) lines.push('', `Filed under the service account on behalf of ${reporterName}.`);
  return lines.join('\n');
}

// ── The sequence ──────────────────────────────────────────────────────────────

type LifecycleContext = {
  readonly correlationId: string;
  readonly now: Date;
  readonly ts: string;
  readonly tuning: GateTuning;
  readonly report: ProblemReport;
  readonly source: ParseResult['source'];
  readonly repairAttempted: boolean | undefined;
  readonly identity: { hash: string; snowUserId: string | null; affiliation: string };
};

export async function handleReport(req: ReportRequest, deps: OrchestratorDeps): Promise<ReportResponse> {
  const correlationId = deps.newCorrelationId();
  // ONE clock read for the whole request. Every timestamp and every window
  // comparison below derives from this instant, so a request cannot straddle two
  // "nows" and reach two different conclusions about the same candidate.
  const now = deps.clock();
  const ts = now.toISOString();
  const tuning = gateTuning();

  const write = (line: Omit<AuditLine, 'ts' | 'correlationId' | 'stage'>): void =>
    deps.audit.write({ ts, correlationId, stage: deps.stage, ...line });

  const unavailable = (
    reason: 'identity_unavailable' | 'incident_search_failed' | 'ticket_create_failed' | 'ticket_create_ambiguous',
  ): ReportResponse => ({ outcome: 'UNAVAILABLE', reply: compose({ outcome: 'UNAVAILABLE', reason }) });

  // 1. PARSE — never throws; unknown values normalize (report_parser.md).
  const { report, source, repairAttempted } = await deps.parser.parse(req.text);

  // 2. IDENTITY — no identity means no throttle key and no requester.
  let identity: { hash: string; snowUserId: string | null; affiliation: string };
  try {
    identity = await deps.identity.resolve(req.identityRef);
  } catch {
    writeParsed(req, report, source, repairAttempted, write);
    write({ action: 'error', errorKind: 'identity_unavailable' });
    return unavailable('identity_unavailable');
  }

  const context: LifecycleContext = { correlationId, now, ts, tuning, report, source, repairAttempted, identity };
  const overrideMatchId = req.overrideMatchId ?? '';
  if (overrideMatchId !== '') return runLifecycle(req, deps, context);

  const key = idempotencyKey(identity.hash, report);
  return coordinateInFlight(deps.idempotency, key, () => runLifecycle(req, deps, context));
}

function writeParsed(
  req: ReportRequest,
  report: ProblemReport,
  source: ParseResult['source'],
  repairAttempted: boolean | undefined,
  write: (line: Omit<AuditLine, 'ts' | 'correlationId' | 'stage'>) => void,
): void {
  write({
    action: 'parsed',
    service: report.service,
    scope: report.scope,
    location: report.location,
    building: report.building,
    room: report.room,
    symptom: report.symptom,
    parseSource: source,
    repairAttempted,
  });
  if (req.text.trim() === '') write({ action: 'error', errorKind: 'empty_report' });
  if (report.scope === 'unknown' && report.location !== '') {
    write({ action: 'error', errorKind: 'incoherent_report' });
  }
}

async function runLifecycle(
  req: ReportRequest,
  deps: OrchestratorDeps,
  context: LifecycleContext,
): Promise<ReportResponse> {
  const { correlationId, now, ts, tuning, report, source, repairAttempted, identity } = context;
  const write = (line: Omit<AuditLine, 'ts' | 'correlationId' | 'stage'>): void =>
    deps.audit.write({ ts, correlationId, stage: deps.stage, ...line });
  const unavailable = (
    reason: 'identity_unavailable' | 'incident_search_failed' | 'ticket_create_failed' | 'ticket_create_ambiguous',
  ): ReportResponse => ({ outcome: 'UNAVAILABLE', reply: compose({ outcome: 'UNAVAILABLE', reason }) });

  writeParsed(req, report, source, repairAttempted, write);

  // 3. THROTTLE — before the search, so a throttled identity generates no read
  //    load against IT systems either.
  const budget = await deps.limiter.check(identity.hash);
  if (!budget.allowed) {
    write({ action: 'throttled', reporterHash: identity.hash, service: report.service, errorKind: 'throttled' });
    return {
      outcome: 'THROTTLED',
      reply: compose({ outcome: 'THROTTLED', retryAfterSeconds: budget.retryAfterSeconds }),
    };
  }

  // 4. IDEMPOTENCY — an override is NEVER suppressed by the key; the user is
  //    deliberately resubmitting the same text, which is the whole mechanism.
  const overrideMatchId = req.overrideMatchId ?? '';
  const isOverride = overrideMatchId !== '';
  const key = idempotencyKey(identity.hash, report);
  if (!isOverride) {
    const prior = deps.idempotency.get(key, now);
    if (prior !== null) return prior;
  }

  // Budget is spent on genuinely new reports only — the idempotent repeat above
  // returned without reaching here, because charging someone for their own retry
  // is a bug that punishes flaky networks. Overrides DO consume budget: the
  // escape hatch stays open, but it is not free (report_throttle.md).
  await deps.limiter.record(identity.hash, report);

  // 5. COMPLETENESS
  const missing = missingFields(report);
  let effective = report;
  if (missing.length > 0) {
    if (req.canFollowUp) {
      // Never file a ticket a human cannot act on. No search, no ticket, no event.
      return {
        outcome: 'NEEDS_DETAIL',
        reply: compose({ outcome: 'NEEDS_DETAIL', missingFields: missing }),
        missingFields: missing,
      };
    }
    // A one-shot form cannot ask, and silently dropping the report is worse than
    // a slightly under-specified request. REQ is the safe direction: it inflates
    // no incident count and deflects nobody.
    effective = { ...report, scope: report.scope === 'unknown' ? 'individual' : report.scope };
  }

  // 6. SEARCH — retry once, then UNAVAILABLE. Never fall through to filing.
  let raw: MatchCandidate[];
  try {
    raw = await deps.incidents.search({
      service: effective.service,
      location: effective.location,
      building: effective.building ?? '',
      room: effective.room ?? '',
      scope: effective.scope,
      symptom: effective.symptom,
    });
  } catch {
    try {
      raw = await deps.incidents.search({
        service: effective.service,
        location: effective.location,
        building: effective.building ?? '',
        room: effective.room ?? '',
        scope: effective.scope,
        symptom: effective.symptom,
      });
    } catch {
      write({ action: 'error', errorKind: 'incident_search_failed' });
      return unavailable('incident_search_failed');
    }
  }

  const candidates = raw.filter((c) => {
    if (isWellFormed(c)) return true;
    write({ action: 'error', errorKind: 'incident_source_malformed' });
    return false;
  });

  write({
    action: 'searched',
    service: effective.service,
    scope: effective.scope,
    location: effective.location,
    building: effective.building,
    room: effective.room,
    symptom: effective.symptom,
    candidateCount: candidates.length,
    declaredCount: candidates.filter((c) => c.kind === 'declared_incident').length,
    topMatchScore: candidates.reduce((m, c) => Math.max(m, c.matchScore), 0),
  });

  // 7. REDUCE — the clock becomes booleans and counts here, and only here.
  const reduced = reduceCandidates(effective, candidates, now, tuning);

  // 8. DECIDE — the only call site in the system.
  const decision = decide(effective, reduced.evidence, isOverride);
  const matchedId =
    decision.outcome === 'MATCHED_DECLARED'
      ? (reduced.topDeclared?.id ?? '')
      : decision.outcome === 'MATCHED_CLUSTER'
        ? (reduced.qualifyingPeers[0]?.id ?? '')
        : '';

  write({
    action: 'decided',
    outcome: decision.outcome,
    topMatchScore: reduced.topMatchScore,
    withinWindow: reduced.evidence.declared?.withinWindow ?? reduced.evidence.peers?.withinWindow ?? false,
    clusterSize: reduced.evidence.peers?.distinctReporters ?? 0,
    // The per-topic ceiling applied — makes "deflected at 10, not 5" auditable.
    clusterThreshold: reduced.clusterThreshold,
    matchedId,
    reporterHash: identity.hash,
  });

  // 9. ACT
  let response: ReportResponse;
  let ticketNumber = '';

  if (isOverride) {
    // Recorded BEFORE the create attempt, so the label survives even if filing
    // fails (match_feedback.md). This is the only labelled matching data the
    // system generates and it has no other source.
    const overridden = candidates.find((c) => c.id === overrideMatchId) ?? null;
    try {
      await deps.feedback.recordOverride({
        matchId: overrideMatchId,
        reporterHash: identity.hash,
        report: effective,
        matchScore: overridden?.matchScore ?? 0,
        kind: overridden?.kind ?? 'unknown',
        ts,
      });
    } catch {
      // The store rejected it; the log still carries the label below.
      write({ action: 'error', errorKind: 'feedback_sink_failed' });
    }
    write({
      action: 'overridden',
      overriddenMatchId: overrideMatchId,
      overriddenScore: overridden?.matchScore ?? 0,
      reporterHash: identity.hash,
    });
  }

  if (decision.outcome === 'MATCHED_DECLARED') {
    const inc = reduced.topDeclared;
    if (inc === null) throw new Error('unreachable: MATCHED_DECLARED without a declared incident');
    response = {
      outcome: 'MATCHED_DECLARED',
      // Quoted verbatim from the record. This is the ONLY outcome permitted to
      // say a service is affected, because IT said it and we cite them with a
      // timestamp.
      reply: compose({
        outcome: 'MATCHED_DECLARED',
        incident: {
          status: inc.status,
          statusUpdatedAt: inc.statusUpdatedAt,
          summary: inc.summary,
          url: inc.url,
        },
      }),
      incident: { id: inc.id, status: inc.status, statusUpdatedAt: inc.statusUpdatedAt, url: inc.url },
      override: { matchId: inc.id },
    };
  } else if (decision.outcome === 'MATCHED_CLUSTER') {
    const ticketIds = reduced.qualifyingPeers.map((p) => p.id);
    const tickets = reduced.qualifyingPeers.map((p) => ({ ticketNumber: p.id, url: p.url }));
    response = {
      outcome: 'MATCHED_CLUSTER',
      reply: compose({
        outcome: 'MATCHED_CLUSTER',
        reportCount: reduced.evidence.peers?.distinctReporters ?? 0,
        ticketIds,
      }),
      cluster: { reportCount: reduced.evidence.peers?.distinctReporters ?? 0, ticketIds, tickets },
      override: { matchId: matchedId },
    };
  } else {
    const ticketClass = decision.outcome === 'FILE_INCIDENT' ? 'INC' : 'REQ';
    const payload: TicketPayload = {
      ticketClass,
      // The IT category tree is not configured, so
      // category reuses the service without inventing a new vocabulary. Replace
      // it adapter-side when the real tree is available.
      category: effective.service,
      service: effective.service,
      scope: effective.scope as TicketScope,
      location: effective.location,
      building: effective.building,
      room: effective.room,
      symptom: effective.symptom,
      observedAt: effective.observedAt,
      description: buildDescription(
        effective,
        `reporter ${identity.hash}`,
        identity.snowUserId === null,
      ),
      requester: {
        snowUserId: identity.snowUserId,
        // Synthetic handle, never a name: stage 1 resolves no directory and this
        // string reaches a ticket body (boundaries.md — no real PII, ever).
        reporterName: `reporter ${identity.hash}`,
        affiliation: identity.affiliation,
      },
      reportedVia: 'campus-issue-reporter',
      peerTicketIds: reduced.qualifyingPeers.map((p) => p.id),
      clusterSize: reduced.evidence.peers?.distinctReporters ?? 0,
      topMatchScore: reduced.topMatchScore,
      filedViaOverride: isOverride,
      overriddenMatchId: isOverride ? overrideMatchId : '',
      auditCorrelationId: correlationId,
    };

    let created: { ticketNumber: string; url: string };
    try {
      created = await deps.tickets.createTicket(payload);
    } catch (first) {
      if (first instanceof AmbiguousCreateError) {
        // Do NOT retry blind: the first attempt's result was never seen, so a
        // second create could double-file in a way the key cannot catch.
        write({ action: 'error', errorKind: 'ticket_create_ambiguous' });
        return unavailable('ticket_create_ambiguous');
      }
      try {
        created = await deps.tickets.createTicket(payload);
      } catch {
        // NEVER a fabricated ticket number.
        write({ action: 'error', errorKind: 'ticket_create_failed' });
        return unavailable('ticket_create_failed');
      }
    }

    ticketNumber = created.ticketNumber;
    write({
      action: 'filed',
      ticketClass,
      ticketNumber,
      service: effective.service,
      scope: effective.scope,
      location: effective.location,
      building: effective.building,
      room: effective.room,
      symptom: effective.symptom,
      reporterHash: identity.hash,
    });

    response = {
      outcome: ticketClass === 'INC' ? 'FILED_INCIDENT' : 'FILED_REQUEST',
      reply: compose({
        outcome: ticketClass === 'INC' ? 'FILED_INCIDENT' : 'FILED_REQUEST',
        ticketNumber,
        url: created.url,
      }),
      ticket: { ticketNumber, url: created.url },
    };
  }

  // 10. FAN OUT — never blocks, never throws into the caller. A stream outage
  //     degrades detection; the answer is unchanged and still correct.
  try {
    deps.stream.publish({
      ts,
      correlationId,
      service: effective.service,
      scope: effective.scope,
      location: effective.location,
      building: effective.building,
      room: effective.room,
      symptom: effective.symptom,
      observedAt: effective.observedAt,
      reporterHash: identity.hash,
      outcome: decision.outcome,
      ticketNumber,
      viaOverride: isOverride,
    });
    write({ action: 'published', reporterHash: identity.hash });
  } catch {
    write({ action: 'error', errorKind: 'stream_publish_failed' });
  }

  // 11. The result is replayable for the retention window — a retried request
  //     gets this same answer back instead of filing a second ticket.
  if (!isOverride) deps.idempotency.set(key, response, now);
  return response;
}

/** Re-exported so a caller can assert the gate constant without a second literal. */
export { CLUSTER_THRESHOLD };
