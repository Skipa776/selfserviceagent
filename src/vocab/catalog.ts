// Vocabularies — the ONE place every bounded value is enumerated
// (ticket_type_catalog.md). No other file may list a service, scope, symptom, or
// ticket class: the parser matches on these, the ticket mapper reads them, and the
// contract types (../contracts/types.ts) derive their unions from them. If a value
// isn't here, it does not exist in this system. That single-source rule is the
// whole reason this file exists — a vocabulary copied into the parser AND the
// mapper drifts, and the deterministic layer starts matching on strings the search
// index never emits.
//
// PLACEHOLDER: the service, location, and symptom sets are the working Stage-1
// vocabulary pending ITS's real catalog. Scope and ticket
// class are canonical.

// ── Services (PLACEHOLDER — pending the real ITS service catalog) ─────────────
export const SERVICES = ['wifi', 'wired_network', 'vpn', 'web_portal', 'classroom_av', 'unknown'] as const;
export type Service = (typeof SERVICES)[number];

// ── Scope (canonical — this is what drives INC vs REQ) ────────────────────────
export const SCOPES = ['individual', 'location', 'service_wide', 'unknown'] as const;
export type ReportScope = (typeof SCOPES)[number];
/** Scope once 'unknown' has been resolved away. */
export type TicketScope = Exclude<ReportScope, 'unknown'>;

// ── Symptoms (PLACEHOLDER) — a triage/matching signal only, NEVER a class input ─
export const SYMPTOMS = [
  'no_connection',
  'intermittent',
  'slow',
  'page_error',
  'auth_failure',
  'equipment_unavailable',
  'unknown',
] as const;
export type Symptom = (typeof SYMPTOMS)[number];

// ── Ticket classes (canonical) ────────────────────────────────────────────────
// INC = a shared service is degraded (scope location / service_wide).
// REQ = one individual's problem with an otherwise-healthy service (scope individual).
// There is no third class and no priority field this tool sets.
export const TICKET_CLASSES = ['INC', 'REQ'] as const;
export type TicketClass = (typeof TICKET_CLASSES)[number];

// Building and room vocabularies live in locations.ts. `location` remains the
// area/demo token for compatibility with the existing matching boundary.

// ── scope → ticket class ──────────────────────────────────────────────────────
// Ticket class is a total function of resolved scope only. Symptoms cannot alter
// whether a report becomes an INC or REQ.

const TICKET_CLASS_BY_SCOPE: Record<TicketScope, TicketClass> = {
  individual: 'REQ',
  location: 'INC',
  service_wide: 'INC',
};

export function ticketClassFor(scope: TicketScope): TicketClass {
  return TICKET_CLASS_BY_SCOPE[scope];
}
