// The append-only audit trail (contracts/audit_log.md). One JSON object per
// line, one line per action.
//
// This is not logging. It is the system's only measurement instrument: a
// deflected report never becomes a ticket in ServiceNow, so the duplicate-rate
// duplicate-rate question is answerable from this log or from nowhere. It
// is built before there is anything to measure, deliberately — retrofitting it
// after launch means losing the launch data.

import type { ApiOutcome } from './contracts/types';

/** One line. Fields are optional per action; the contract lists which go where. */
export type AuditLine = {
  readonly ts: string; // ISO-8601
  readonly correlationId: string; // one per request; matches TicketPayload + ReportEvent
  readonly stage: 1 | 2 | 3; // the log outlives the stage
  readonly action:
    | 'parsed'
    | 'searched'
    | 'decided'
    | 'filed'
    | 'published'
    | 'overridden'
    | 'throttled'
    | 'linked' // a child report added to an open parent incident (flood ledger)
    | 'recommended' // the parent's pending priority raise was set or replaced
    | 'replied' // the last line of every request: what the person was told
    | 'error';

  readonly service?: string;
  readonly scope?: string;
  readonly location?: string;
  readonly building?: string;
  readonly room?: string;
  readonly symptom?: string;

  readonly candidateCount?: number;
  readonly declaredCount?: number;
  readonly topMatchScore?: number;
  readonly withinWindow?: boolean;
  readonly clusterSize?: number;
  /** The per-topic deflection ceiling applied to this report (clusterGate.ts). */
  readonly clusterThreshold?: number;

  readonly outcome?: 'MATCHED_DECLARED' | 'MATCHED_CLUSTER' | 'FILE_INCIDENT' | 'FILE_REQUEST';
  /** 'replied' only: the API outcome the caller received, including replays (so not a ticket count). */
  readonly apiOutcome?: ApiOutcome;
  readonly matchedId?: string;

  readonly ticketClass?: 'INC' | 'REQ';
  readonly ticketNumber?: string;

  /** ServiceNow priority 1-5 set at create, or recommended later. */
  readonly priority?: number;
  /** The priority-policy rule that produced `priority`. */
  readonly policyRuleId?: string;
  /** Whether the report's own words read as frustrated (frustration.ts). */
  readonly frustrated?: boolean;

  readonly overriddenMatchId?: string;
  /** The score that was wrong. THIS FIELD IS THE LABELLED TRAINING DATA. */
  readonly overriddenScore?: number;

  readonly parseSource?: 'keyword' | 'llm' | 'specialist';
  readonly repairAttempted?: boolean;
  /** Stage 2: the specialist's per-head confidence, threshold and training-data hash, so
   *  a later review can recompute risk-coverage and tell which model version answered. */
  readonly specialistConfidence?: { readonly service: number; readonly scope: number; readonly symptom: number };
  readonly specialistTau?: number | null;
  readonly specialistDataset?: string;

  /** Salted hash, NEVER a raw identity. */
  readonly reporterHash?: string;
  /** A row key from safety/error_rescue_map.md. */
  readonly errorKind?: string;
};

/**
 * Collects lines in order and optionally forwards each to a sink.
 *
 * The in-memory array is the stage-1 store; the composition root passes a sink
 * that appends JSONL to a file. The stage-3 upgrade path (durable,
 * with retention) is a different sink, not a different logger — retention and
 * location are deliberately undecided (audit_log.md, data_handling.md).
 */
export class AuditLog {
  readonly lines: AuditLine[] = [];

  constructor(private readonly sink?: (line: AuditLine) => void) {}

  write(line: AuditLine): void {
    this.lines.push(line);
    this.sink?.(line);
  }

  /** The whole log as JSONL — what the demo prints and what a query would read. */
  toJSONL(): string {
    return this.lines.map((l) => JSON.stringify(l)).join('\n');
  }
}
