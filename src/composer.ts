// Response composer — every word this service says to a person
// (components/response_composer.md).
//
// A rule about not fabricating is worthless unless exactly ONE code path could
// fabricate and it structurally cannot. This is that path. No reply string is
// assembled anywhere else in the system.
//
// ── The structural trick, and it is the same one decide() uses ────────────────
// ComposeInput is a DISCRIMINATED UNION: one variant per outcome, each carrying
// only the fields its template is allowed to quote. The MATCHED_CLUSTER variant
// has no `status`, no `summary`, no incident at all — so the cluster template
// cannot claim a service is down even if someone edited it carelessly, because
// there is nothing in scope to claim it with. Compare MATCHED_DECLARED, which
// does carry those fields, because ITS said them and we are quoting with a
// timestamp.

import type { ApiOutcome } from './contracts/types';

/**
 * PLACEHOLDER — the real ITS Service Desk contact details are not in this bundle
 * until the production service desk mapping is approved. Every UNAVAILABLE and THROTTLED reply must end in a
 * human path: someone whose wifi is down is being told by their university's
 * assistant that it cannot help right now, and that reply must not be a dead end.
 */
export const HUMAN_PATH = 'the ITS Service Desk at https://support.example.edu';

export type ComposeInput =
  | {
      readonly outcome: 'MATCHED_DECLARED';
      /** Quoted verbatim from the record — the only authority we have to speak with. */
      readonly incident: {
        readonly status: string;
        readonly statusUpdatedAt: string;
        readonly summary: string;
        readonly url: string;
      };
    }
  | {
      readonly outcome: 'MATCHED_CLUSTER';
      /** Counts only. There is deliberately no status field in this variant. */
      readonly reportCount: number;
      readonly ticketIds: readonly string[];
    }
  | { readonly outcome: 'FILED_INCIDENT'; readonly ticketNumber: string; readonly url: string }
  | { readonly outcome: 'FILED_REQUEST'; readonly ticketNumber: string; readonly url: string }
  | { readonly outcome: 'NEEDS_DETAIL'; readonly missingFields: readonly string[] }
  | { readonly outcome: 'THROTTLED'; readonly retryAfterSeconds: number }
  | {
      readonly outcome: 'UNAVAILABLE';
      readonly reason:
        | 'identity_unavailable'
        | 'incident_search_failed'
        | 'ticket_create_failed'
        | 'ticket_create_ambiguous';
    };

/** The plain-language way to say "this isn't my issue" — on BOTH deflect replies. */
const OVERRIDE_AFFORDANCE =
  'If that is not the same problem you are having, reply "this is not my issue" ' +
  'and I will file your report separately.';

/** missingFields values → the question a person can actually answer. */
const FIELD_QUESTIONS: Record<string, string> = {
  service: 'which service this is about — for example wifi, VPN, or a campus website',
  scope: 'whether this is affecting just you, one building, or the whole campus',
  location: 'which building or area you are in',
};

function unavailableDetail(reason: Extract<ComposeInput, { outcome: 'UNAVAILABLE' }>['reason']): string {
  switch (reason) {
    case 'ticket_create_ambiguous':
      // error_rescue_map.md: do NOT retry blind, and say so honestly. A duplicate
      // is cheap; a silent double-file is a lie about what happened.
      return 'Your report may already have been filed — I lost contact before I could confirm it.';
    case 'ticket_create_failed':
      return 'I could not file your report.';
    case 'identity_unavailable':
      return 'I could not verify who is reporting this, so I have not filed anything.';
    case 'incident_search_failed':
      // The load-bearing one: we refuse to file blind rather than flood ITS during
      // exactly the incident that broke the search.
      return 'I could not check whether this is already known, so I have not filed anything — I do not want to add a duplicate to a problem I cannot see.';
  }
}

/**
 * The seven templates. Every outcome has exactly one; a missing template is a
 * BUILD-TIME failure (the union above makes the switch exhaustive), never a
 * runtime fallback to an empty string.
 *
 * Note what is absent: `ProblemReport.verbatim` is never interpolated into a
 * reply. Echoing user text back through a template is a reflection surface with
 * no upside here — verbatim's only destination is the ticket body.
 */
export function compose(input: ComposeInput): string {
  switch (input.outcome) {
    case 'MATCHED_DECLARED': {
      const { summary, status, statusUpdatedAt, url } = input.incident;
      // statusUpdatedAt ALWAYS accompanies status — a status without its
      // timestamp reads as current, and it may be hours stale. No ETA, ever.
      return (
        `ITS has an open incident that looks like it covers this. They describe it as: ` +
        `"${summary}". The status they have published is "${status}", last updated ${statusUpdatedAt}. ` +
        `Details: ${url}. I have not created a new ticket. ${OVERRIDE_AFFORDANCE}`
      );
    }

    case 'MATCHED_CLUSTER': {
      // A true statement about OUR OWN RECORDS, and it stops there. Not "this is a
      // known issue", not "the service is down" — five people reporting a problem
      // is five people reporting a problem, and saying otherwise would make this
      // service a second source of truth about campus infrastructure
      // (boundaries.md boundary 2).
      const others = input.reportCount === 1 ? '1 other person has' : `${input.reportCount} other people have`;
      const tickets = input.ticketIds.length === 1 ? 'a ticket is' : 'tickets are';
      return (
        `${others} recently reported something similar, and ${tickets} already open for it ` +
        `(${input.ticketIds.join(', ')}). I have not created another one. ${OVERRIDE_AFFORDANCE}`
      );
    }

    case 'FILED_INCIDENT':
      return (
        `I have filed this as an incident: ${input.ticketNumber}. ITS handles incidents that affect a ` +
        `shared service. Any updates will appear on the ticket: ${input.url}`
      );

    case 'FILED_REQUEST':
      return (
        `I have filed this as a request: ${input.ticketNumber}. ITS handles requests that affect one ` +
        `person's access to a service. Any updates will appear on the ticket: ${input.url}`
      );

    case 'NEEDS_DETAIL': {
      // One question, in plain words. Asking for four fields at once is how a
      // form feels; asking for the one thing that blocks us is how a person helps.
      const first = input.missingFields[0] ?? 'scope';
      const question = FIELD_QUESTIONS[first] ?? 'a little more detail about the problem';
      return `Before I can do anything useful with this, I need to know ${question}. Could you tell me that?`;
    }

    case 'THROTTLED': {
      const minutes = Math.max(1, Math.ceil(input.retryAfterSeconds / 60));
      return (
        `I have received a lot of reports from this account recently, so I am pausing new ones for now. ` +
        `You can try again in about ${minutes} minute${minutes === 1 ? '' : 's'}, or contact ${HUMAN_PATH} directly.`
      );
    }

    case 'UNAVAILABLE':
      return `${unavailableDetail(input.reason)} Please contact ${HUMAN_PATH} so this does not get lost.`;
  }
}

/** Compile-time proof that every API outcome has a template variant above. */
export type ComposedOutcomes = ComposeInput['outcome'];
const _everyOutcomeHasATemplate: Record<ApiOutcome, true> = {
  MATCHED_DECLARED: true,
  MATCHED_CLUSTER: true,
  FILED_INCIDENT: true,
  FILED_REQUEST: true,
  NEEDS_DETAIL: true,
  THROTTLED: true,
  UNAVAILABLE: true,
};
void _everyOutcomeHasATemplate;
