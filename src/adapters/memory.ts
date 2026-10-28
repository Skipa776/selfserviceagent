// In-memory adapter implementations — the whole of stage-1 wiring
// (components/mock_adapters.md). Everything local, nothing configured, no
// network, no credentials. `npm test` passes on a fresh clone with an empty
// environment, and that property is the point of stage 1.
//
// These implement the seven interfaces in ../contracts/adapters.ts and add
// nothing. An in-memory adapter is never more capable than its contract:
// there is no close(), update(), escalate(), acknowledge() or resolve() here
// either, because the interfaces have none and the governance control IS the
// method list.
//
// The only extra surface is SETUP — `seed()` on the incident source, `failTimes`
// on each adapter. That is fixture-world construction and test-only failure
// injection, never called from the request path. The orchestrator sees the
// interface and nothing else, which is why stage 2 swaps this file's TicketSink
// for a ServiceNow PDI and no caller notices.

import { createHash } from 'node:crypto';

import type {
  IdentityContext,
  IncidentSource,
  MatchFeedbackSink,
  ReportRateLimiter,
  ReportStream,
  StatusReader,
  TicketSink,
} from '../contracts/adapters';
import type { MatchCandidate, ProblemReport, ReportEvent, TicketPayload } from '../contracts/types';
import { throttleLimits } from '../throttleLimits';
import { scoreCandidate, type SearchQuery } from './scoring';

/** A clock the caller owns. Injected everywhere a time is read, so no test waits. */
export type Clock = () => Date;

/**
 * Create timed out with an unknown outcome — distinct from a plain failure
 * because the required behaviour differs (error_rescue_map.md:
 * `ticket_create_ambiguous` must NOT retry blind; `ticket_create_failed` retries
 * once). The orchestrator attributes every other failure by call site.
 */
export class AmbiguousCreateError extends Error {
  constructor() {
    super('ticket create timed out with an unknown outcome');
    this.name = 'AmbiguousCreateError';
  }
}

/**
 * Test-only failure injection (mock_adapters.md, "Each has a test-only failure
 * injection"). `failTimes` counts DOWN: 1 reproduces a transient failure that a
 * single retry rescues, Infinity reproduces a dependency that is simply down.
 * Both shapes are needed — error_rescue_map.md's retry-once rows are only
 * meaningfully tested if the retry can succeed.
 */
class Injectable {
  failTimes = 0;

  protected shouldFail(): boolean {
    if (this.failTimes <= 0) return false;
    this.failTimes -= 1;
    return true;
  }
}

// ── IncidentSource ────────────────────────────────────────────────────────────

// The scorer moved to ./scoring.ts at stage 2 so the ServiceNow adapter uses the
// SAME formula — see that file for why sharing it is required rather than tidy.
export class InMemoryIncidentSource extends Injectable implements IncidentSource {
  private candidates: MatchCandidate[] = [];

  /**
   * SETUP ONLY — builds the fixture world (mock_adapters.md: "an in-memory list
   * of MatchCandidates seeded per scenario"). Never called from the request path;
   * the orchestrator only ever calls search().
   */
  seed(candidates: readonly MatchCandidate[]): void {
    this.candidates = [...candidates];
  }

  /**
   * SETUP ONLY — appends one candidate. The demo uses it to feed tickets this
   * service just filed back in as peers, which is what stage 2 gets for free by
   * reading peer tickets back out of the ServiceNow PDI.
   */
  add(candidate: MatchCandidate): void {
    this.candidates.push(candidate);
  }

  async search(q: SearchQuery): Promise<MatchCandidate[]> {
    if (this.shouldFail()) throw new Error('incident source unreachable');

    return this.candidates
      .filter((c) => c.service === q.service)
      // matchScore is computed by the adapter, not carried from the source
      // (match_candidate.md) — the seeded value is overwritten here on purpose.
      .map((c) => ({ ...c, matchScore: scoreCandidate(q, c) }))
      .sort((a, b) => b.matchScore - a.matchScore);
  }
}

// ── TicketSink ────────────────────────────────────────────────────────────────

export class InMemoryTicketSink extends Injectable implements TicketSink {
  /** Every payload accepted, in order — the assertion surface for flow tests. */
  readonly filed: TicketPayload[] = [];
  /** Test-only: make the next failure an ambiguous timeout rather than a refusal. */
  ambiguous = false;

  private counter = 0;

  async createTicket(payload: TicketPayload): Promise<{ ticketNumber: string; url: string }> {
    if (this.shouldFail()) {
      if (this.ambiguous) throw new AmbiguousCreateError();
      throw new Error('ticket create failed');
    }

    this.counter += 1;
    // Realistic-looking numbers so a filed payload reads like a real one to the
    // manager. They are still local; nothing here fabricates a number on failure
    // (error_rescue_map.md) — the throw above happens first.
    const ticketNumber = `${payload.ticketClass}00${String(this.counter).padStart(5, '0')}`;
    this.filed.push(payload);
    return { ticketNumber, url: `https://its.example.edu/ticket/${ticketNumber}` };
  }
}

// ── ReportStream ──────────────────────────────────────────────────────────────

export class InMemoryReportStream implements ReportStream {
  readonly events: ReportEvent[] = [];
  /** Test-only: publish throws internally. The caller's result must not change. */
  fail = false;

  publish(event: ReportEvent): void {
    if (this.fail) throw new Error('stream publish failed');
    this.events.push(event);
  }
}

// ── MatchFeedbackSink ─────────────────────────────────────────────────────────

type OverrideRecord = {
  matchId: string;
  reporterHash: string;
  report: ProblemReport;
  matchScore: number;
  kind: string;
  ts: string;
};

export class InMemoryMatchFeedbackSink extends Injectable implements MatchFeedbackSink {
  /** The labelled false positives — the only matching-quality data we generate. */
  readonly overrides: OverrideRecord[] = [];

  async recordOverride(f: OverrideRecord): Promise<void> {
    if (this.shouldFail()) throw new Error('feedback sink failed');
    this.overrides.push(f);
  }
}

// ── IdentityContext ───────────────────────────────────────────────────────────

/**
 * Synthetic identity. No real PII, ever (mock_adapters.md, boundaries.md), and no
 * authentication — this service authenticates nobody.
 *
 * Deliberate deviation, recorded: mock_adapters.md says "one fixed synthetic
 * reporter", but the demo's centrepiece is the count boundary (four file, the
 * fifth deflects) and that is undemonstrable live if every caller resolves to the
 * same reporterHash. So the hash is derived deterministically from the opaque
 * identityRef instead — still synthetic, still salted, still no identity stored.
 * The salt is per-deployment, not per-request: a per-request salt makes every
 * reporter look distinct and silently breaks the entire trigger rule
 * (pattern_alert.md).
 */
export class InMemoryIdentityContext extends Injectable implements IdentityContext {
  constructor(private readonly salt = 'stage1-demo-salt') {
    super();
  }

  async resolve(identityRef: string): Promise<{
    hash: string;
    snowUserId: string | null;
    affiliation: string;
  }> {
    if (this.shouldFail()) throw new Error('identity unavailable');

    const hash = createHash('sha256').update(`${this.salt}:${identityRef}`).digest('hex').slice(0, 16);
    // snowUserId: null is the NORMAL service-account case, never an error
    // (adapters.md). Stage 1 has no SSO, so it is always null and the reporter is
    // named in the ticket body instead (ticket_payload.md).
    return { hash, snowUserId: null, affiliation: 'campus-member' };
  }
}

// ── ReportRateLimiter ─────────────────────────────────────────────────────────

type Hit = { at: number; service: string };

export class InMemoryRateLimiter extends Injectable implements ReportRateLimiter {
  private readonly hits = new Map<string, Hit[]>();

  /** The clock is injectable so window rollover is testable without waiting
   *  (report_throttle.md: "a throttle that can only be tested by waiting is a
   *  throttle that does not get tested"). */
  constructor(private readonly clock: Clock) {
    super();
  }

  private recent(hash: string): Hit[] {
    const { windowMinutes } = throttleLimits();
    const cutoff = this.clock().getTime() - windowMinutes * 60_000;
    const kept = (this.hits.get(hash) ?? []).filter((h) => h.at > cutoff);
    this.hits.set(hash, kept);
    return kept;
  }

  async check(hash: string): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const { windowMinutes, maxReportsPerIdentity, maxDistinctServicesPerWindow } = throttleLimits();
    const hits = this.recent(hash);

    const overCount = hits.length >= maxReportsPerIdentity;
    const overVariety = new Set(hits.map((h) => h.service)).size >= maxDistinctServicesPerWindow;
    if (!overCount && !overVariety) return { allowed: true, retryAfterSeconds: 0 };

    // Budget returns when the oldest hit in the window ages out.
    const oldest = Math.min(...hits.map((h) => h.at));
    const readyAt = oldest + windowMinutes * 60_000;
    const retryAfterSeconds = Math.max(1, Math.ceil((readyAt - this.clock().getTime()) / 1000));
    return { allowed: false, retryAfterSeconds };
  }

  async record(hash: string, report: ProblemReport): Promise<void> {
    const hits = this.recent(hash);
    hits.push({ at: this.clock().getTime(), service: report.service });
    this.hits.set(hash, hits);
  }
}

// ── StatusReader — present, NOT wired ─────────────────────────────────────────

/**
 * STAGE 3 ONLY. It is deliberately not passed to the composition root before
 * stage 3. Returning null is honest while no status source is wired: null means
 * "not found", never a guessed status.
 *
 * Leaving it unwired rather than deleting it is the seam argument in miniature —
 * stage 3 wires this in and GET /status appears, with no change above the
 * composition root.
 */
export class UnwiredStatusReader implements StatusReader {
  async readStatus(): Promise<{ status: string; statusUpdatedAt: string } | null> {
    return null;
  }
}
