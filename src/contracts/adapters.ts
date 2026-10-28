// Adapter interfaces — the seams to systems we don't own (adapters.md).
//
// THE METHOD LIST IS THE GOVERNANCE CONTROL. safety/boundaries.md requires that
// the only external side effect is creating one ticket. That is not enforced by a
// comment — it is enforced by the fact that NONE of these interfaces has a
// `close`, `update`, `escalate`, `reassign`, `acknowledge`, or `resolve` method.
// There is nothing to call even if a bug wanted to. Do not add such a method
// without an explicit safety-boundary change. These seven are also the entire
// mechanism of the three-stage plan: a stage transition changes only which
// implementation the composition root wires in — never these interfaces.
//
// TS note: an `interface` here is a *contract for behaviour* (methods), not data.
// A class or object "satisfies" it structurally — TypeScript is structurally
// typed, so anything with matching method signatures counts as an IncidentSource,
// no `implements` keyword required (though we'll use it for clarity). This is
// "duck typing", checked at compile time.

import type { MatchCandidate, ProblemReport, ReportEvent, TicketPayload } from './types';

export interface IncidentSource {
  // READ ONLY. Returns declared incidents AND peer tickets in one call — the
  // caller needs both to evaluate cluster_gate.md, and two round trips could
  // disagree about "now". Sorted by matchScore desc.
  search(q: {
    service: string; // catalog vocabulary
    location: string; // '' when not location-scoped
    building: string;
    room: string;
    scope: string;
    symptom: string;
  }): Promise<MatchCandidate[]>;
  // NO write / close / update / acknowledge method exists here, by design.
}

export interface TicketSink {
  // CREATE ONLY. MUST throw (never return a fabricated ticketNumber) on any
  // failure — see safety/error_rescue_map.md (ticket_create_failed).
  createTicket(payload: TicketPayload): Promise<{ ticketNumber: string; url: string }>;
  // NO update / close / comment / reassign method exists here, by design.
}

export interface StatusReader {
  // READ ONLY — STAGE 3 ONLY. Not wired at stage 1. Backs GET /status and the
  // fresh status read on a MATCHED_DECLARED reply. null = not found, never a guess.
  readStatus(ticketId: string): Promise<{ status: string; statusUpdatedAt: string } | null>;
}

export interface ReportStream {
  // FIRE AND FORGET. Returns void, not a Promise: the user's response path never
  // awaits it and never fails because of it (pattern_alert.md).
  publish(event: ReportEvent): void;
}

export interface MatchFeedbackSink {
  // APPEND ONLY. Every "this isn't my issue" override lands here as a labelled
  // false positive — the only matching-quality data this system generates
  // (match_feedback.md).
  recordOverride(f: {
    matchId: string;
    reporterHash: string;
    report: ProblemReport;
    matchScore: number;
    kind: string;
    ts: string;
  }): Promise<void>;
}

export interface IdentityContext {
  // READ ONLY, caller-owned. Identity originates in the caller's session; this
  // service authenticates nobody and stores no credentials. snowUserId: null is a
  // NORMAL case (service-account fallback), never an error.
  resolve(identityRef: string): Promise<{
    hash: string; // salted; used everywhere except the ticket requester field
    snowUserId: string | null; // null -> service-account fallback
    affiliation: string;
  }>;
}

export interface ReportRateLimiter {
  // safety/report_throttle.md. check() runs BEFORE the incident search so a
  // throttled identity generates no read load.
  check(hash: string): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  record(hash: string, report: ProblemReport): Promise<void>;
}
