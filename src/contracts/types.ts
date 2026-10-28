// Contracts as code — the six data shapes the whole system speaks in.
//
// These match the OKF contract files field-for-field. If a contract and this file
// disagree, the contract wins and this file is the bug.
//
// ── Shared vocabularies ───────────────────────────────────────────────────────
// ReportScope / TicketScope / TicketClass are ENUMERATED once, in vocab/catalog.ts
// (ticket_type_catalog.md owns every bounded vocabulary — "no other file enumerates
// these values"). We import them for use in the shapes below and re-export them so
// anything importing from ./types still gets them. The values live there; only the
// shapes live here.
import type { ReportScope, TicketScope, TicketClass } from '../vocab/catalog';
export type { ReportScope, TicketScope, TicketClass };

/** The four things decide() can return. The API adds three more (api_contract). */
export type DecideOutcome =
  | 'MATCHED_DECLARED'
  | 'MATCHED_CLUSTER'
  | 'FILE_INCIDENT'
  | 'FILE_REQUEST';

/**
 * The seven outcomes `POST /report` can return (api_contract.md). Note the
 * filing pair is PAST tense: decide() says `FILE_*` (a decision), the API reports
 * `FILED_*` (a ticket now exists). The other three are orchestrator-level results
 * decide() never produces. Full request/response shapes land with the API surface;
 * the corpus needs the outcome vocabulary now, so it lives here (contracts as code).
 */
export type ApiOutcome =
  | 'MATCHED_DECLARED'
  | 'MATCHED_CLUSTER'
  | 'FILED_INCIDENT'
  | 'FILED_REQUEST'
  | 'NEEDS_DETAIL'
  | 'THROTTLED'
  | 'UNAVAILABLE';

// ── ProblemReport — the parsing boundary (problem_report.md) ──────────────────
// THE STAGE SEAM. The only shape a parser may produce, identical whether the
// keyword extractor (stage 1) or the LLM (stage 2+) made it. Exactly eight fields:
// no outcome/priority/confidence/isOutage field exists, which is the structural
// reason the LLM cannot decide anything.
export type ProblemReport = {
  readonly service: string; // catalog vocabulary, or 'unknown'
  readonly scope: ReportScope;
  readonly location: string; // catalog vocabulary, or ''
  readonly building: string; // canonical building code, or ''
  readonly room: string; // canonical room token, or ''
  readonly symptom: string; // catalog vocabulary, or 'unknown'
  readonly observedAt: string; // ISO-8601 as the USER reported it; '' if unstated
  readonly verbatim: string; // the user's own words, never interpreted
};

// ── MatchCandidate — what a search returns (match_candidate.md) ───────────────
// Two kinds, and conflating them is the most dangerous mistake in the system:
//   declared_incident — authoritative; we may quote its status verbatim.
//   peer_ticket       — evidence of volume; says NOTHING about service state.

/** Fields common to both kinds of match. */
interface MatchCandidateBase {
  readonly id: string; // the source system's id (INC…/REQ…)
  readonly service: string; // catalog vocabulary
  readonly scope: TicketScope;
  readonly locations: readonly string[]; // catalog vocabulary; [] when service_wide
  readonly building: string;
  readonly room: string;
  readonly symptom: string; // catalog vocabulary
  readonly openedAt: string; // ISO-8601, from the source
  readonly matchScore: number; // computed by the adapter, not the source
  readonly reporterHash: string; // '' on declared incidents; counts distinct reporters on peers
  readonly url: string;
}

/** A peer ticket: someone else's report we think matches. No status to quote. */
export interface PeerTicket extends MatchCandidateBase {
  readonly kind: 'peer_ticket';
}

// The discriminated union keeps authoritative status fields required on declared
// incidents and unrepresentable on peer tickets. Five reports are not an outage.
export interface DeclaredIncident extends MatchCandidateBase {
  readonly kind: 'declared_incident';
  readonly status: string;
  readonly statusUpdatedAt: string;
  readonly summary: string;
};

export type MatchCandidate = DeclaredIncident | PeerTicket;
// ── Decision — the pure output of decide() (decision.md) ──────────────────────
// `reason` is a machine-readable string for the audit log, NOT user-facing copy
// (the composer owns what a person reads).
export type Decision = {
  readonly outcome: DecideOutcome;
  readonly reason: string;
};

// ── TicketPayload — the one shape passed to createTicket() (ticket_payload.md) ─
// Optimized for the IT agent who reads it next: everything except `description`
// is a bounded catalog value; `description` quotes the reporter exactly once and
// is composed by code, never authored by a model.
export interface TicketPayload {
  readonly ticketClass: TicketClass;
  readonly category: string; // IT category string (catalog)
  readonly service: string; // catalog vocabulary
  readonly scope: TicketScope;
  readonly location: string; // catalog vocabulary; '' when not location-scoped
  readonly building: string;
  readonly room: string;
  readonly symptom: string; // catalog vocabulary
  readonly observedAt: string; // ISO-8601 as reported; '' if unstated

  readonly description: string; // verbatim quoted once + parsed fields; NEVER model prose

  readonly requester: {
    readonly snowUserId: string | null; // null -> service account
    readonly reporterName: string; // named in the body when snowUserId is null
    readonly affiliation: string;
  };
  readonly reportedVia: 'campus-issue-reporter'; // constant — makes our tickets measurable

  // The "we did try to dedup" record.
  readonly peerTicketIds: readonly string[]; // matching open tickets found; may be []
  readonly clusterSize: number; // distinct reporters found; 0 if no match
  readonly topMatchScore: number; // best score that failed the gate; 0 if none

  // Override provenance — set only when the user rejected a match.
  readonly filedViaOverride: boolean;
  readonly overriddenMatchId: string; // '' unless filedViaOverride

  readonly auditCorrelationId: string; // ties this ticket to its audit lines
}

// ── ReportEvent — the async fan-out event (pattern_alert.md) ──────────────────
// Published per accepted report, fire-and-forget. Throttled and NEEDS_DETAIL
// reports emit none; override reports DO emit, flagged.
export type ReportEvent = {
  readonly ts: string; // ISO-8601, when the report was received
  readonly correlationId: string; // matches audit log + TicketPayload
  readonly service: string;
  readonly scope: string;
  readonly location: string;
  readonly building: string;
  readonly room: string;
  readonly symptom: string;
  readonly observedAt: string; // as reported; '' if unstated
  readonly reporterHash: string; // salted hash — never a raw identity
  readonly outcome: DecideOutcome;
  readonly ticketNumber: string; // '' when nothing was filed
  readonly viaOverride: boolean;
};

// ── PatternAlert — the advisory NOC signal (pattern_alert.md) ─────────────────
// `status` is ALWAYS 'candidate'. This service never declares an outage.
export type PatternAlert = {
  readonly alertId: string;
  readonly service: string;
  readonly location: string; // '' for a service-wide cluster
  readonly building: string;
  readonly room: string;
  readonly windowMinutes: number;
  readonly distinctReporters: number; // NOT report count
  readonly firstReportAt: string;
  readonly lastReportAt: string;
  readonly ticketNumbers: readonly string[]; // the cluster's filed tickets
  readonly sampleCorrelationIds: readonly string[];
  readonly status: 'candidate'; // ALWAYS — there is no 'declared' value
};
