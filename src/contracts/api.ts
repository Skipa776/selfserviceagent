// The HTTP surface's request/response shapes (contracts/api_contract.md).
//
// Separate from types.ts on purpose: types.ts holds the internal data shapes the
// system speaks in, this file holds the boundary two callers we do not control
// integrate against. "Adding a field is backward-compatible or it is a new
// endpoint" applies to this file and not to that one.

import type { ApiOutcome } from './types';

export type ReportRequest = {
  /** The user's complaint, in their own words. */
  readonly text: string;
  /** Opaque session/identity reference from the caller. This service authenticates nobody. */
  readonly identityRef: string;
  /** true = the caller can ask the user a question and resubmit (api_contract.md). */
  readonly canFollowUp: boolean;
  /** Set when the user said "this isn't my issue" — files regardless of the gate. */
  readonly overrideMatchId?: string;
};

/**
 * The outcome fields are mutually exclusive BY CONSTRUCTION (api_contract.md): a
 * match outcome never carries `ticket`, a filed outcome never carries `incident`
 * or `cluster`. That is what "the dedup outcome creates nothing" means in
 * practice, and the contract test asserts it.
 */
export type ReportResponse = {
  readonly outcome: ApiOutcome;
  /** Plain-language text, composed deterministically (response_composer.md). */
  readonly reply: string;

  /** MATCHED_DECLARED only — quoted verbatim from the record. */
  readonly incident?: {
    readonly id: string;
    readonly status: string;
    readonly statusUpdatedAt: string;
    readonly url: string;
  };
  /** MATCHED_CLUSTER only — counts and source-record links, never a status claim. */
  readonly cluster?: {
    readonly reportCount: number;
    readonly ticketIds: readonly string[];
    readonly tickets: readonly { readonly ticketNumber: string; readonly url: string }[];
  };
  /** FILED_* only. */
  readonly ticket?: { readonly ticketNumber: string; readonly url: string };
  /** NEEDS_DETAIL only. */
  readonly missingFields?: readonly string[];

  /**
   * Present on BOTH match outcomes, never omitted as a UI simplification. The
   * handle the caller sends back as `overrideMatchId`. Without it a person with a
   * real, distinct problem is told it is already handled and has no recourse —
   * and the system loses its only source of matching-quality data.
   */
  readonly override?: { readonly matchId: string };
};
