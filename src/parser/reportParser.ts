// reportParser.ts — the parsing trust boundary (report_parser.md, problem_report.md).
// The ONE place language becomes structured data. Text in, a validated ProblemReport
// out — never a throw, never an out-of-vocabulary value, never a decision.
//
// Stage 1 delegates to the keyword extractor and then runs the shared normalization
// below. Stages 2–3 will call the LLM instead of the extractor and run the SAME
// normalization. That is why normalize() is written now and written defensively: it
// is the identical half of the parser across all three stages, and it is what makes
// "stage 2 changed one module" true. Nothing downstream can tell which parser ran.
//
// Whatever produced the record, it is UNTRUSTED INPUT. normalize() therefore takes
// `unknown`, not a ProblemReport: at stage 2 the LLM can emit missing fields, wrong
// types, null, extra fields, or hostile strings, and every one of those must become
// a clean record here rather than a crash three modules away.

import type { ProblemReport } from '../contracts/types';
import type { ReportScope, Service, Symptom } from '../vocab/catalog';
import { SCOPES, SERVICES, SYMPTOMS } from '../vocab/catalog';
import { extract } from './keywordExtractor';
import { canonicalBuilding, canonicalLocation, canonicalRoom, matchBuilding } from '../vocab/locations';

// This is a hygiene cap (ticket-body size, abuse), not a governed threshold.
// adjust freely if a real ticket-body limit lands. It is not one of the UNSET
// constants (those are the match + throttle values), so a value here is fine.
export const VERBATIM_MAX_LEN = 2000;

// Each normalization rule is a small pure function of its input. Together they
// keep untrusted parser output from requiring defensive checks downstream.

/**
 * Clamp untrusted input to a bounded catalog vocabulary. Unknown or wrongly
 * typed values normalize to the supplied fallback; downstream code does not
 * repeat this check.
 */
function clampVocab<T>(value: unknown, vocab: readonly T[], fallback: T): T {
  if (vocab.includes(value as T)){
    return value as T;
  }
  return fallback;
}

/**
 * A location scope without a location is incoherent. Downgrade it to unknown so
 * the orchestrator asks rather than filing a location incident with no location.
 */
function applyCoherence(scope: ReportScope, location: string): ReportScope {
  if( scope === 'location' && location === ''){
    return 'unknown';
  }
  return scope;
}

/**
 * Quarantine verbatim by accepting strings only, stripping control characters,
 * and applying the length cap. Its only destination is a quoted ticket body.
 */
function sanitizeVerbatim(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .replace(/\p{Cc}/gu, '')
    .slice(0, VERBATIM_MAX_LEN);
}
/**
 * Keep a valid reported timestamp unless it is in the future relative to the
 * injected `now`. Never read the wall clock here; deterministic normalization is
 * required for parser parity. Future model timestamps are discarded rather than
 * allowed to silently defeat match-window checks.
 */
function normalizeObservedAt(value: unknown, now?: Date): string {
  if (typeof value !== 'string'){
    return '';
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return '';
  if (now !== undefined && parsed > now.getTime()) return '';
  return value;
}

// ── Assembly — the eight-field guarantee and untrusted-input coercion ──────────

/**
 * Normalize any untrusted record into a valid ProblemReport. Total and pure: every
 * input yields exactly the eight fields, all in-vocabulary or the honest fallback.
 * Extra fields (a model-emitted `outcome`, `priority`, …) are dropped by
 * construction — the object literal below is the only shape that leaves here, which
 * is the structural reason a parser cannot smuggle a decision downstream.
 *
 * `now` is optional and stage-2 only: the LLM parser passes the injected clock so
 * a hallucinated future `observedAt` can be dropped. Stage 1 passes nothing, and
 * pure normalization stays a pure function of its input.
 */
export function normalize(raw: unknown, now?: Date): ProblemReport {
  const r: Record<string, unknown> =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};

  const location = canonicalLocation(r.location);
  const buildingValue = canonicalBuilding(r.building) || canonicalBuilding(location) || matchBuilding(location)?.building.code || '';
  const scope = clampVocab<ReportScope>(r.scope, SCOPES, 'unknown');

  return {
    service: clampVocab<Service>(r.service, SERVICES, 'unknown'),
    scope: applyCoherence(scope, location),
    location,
    building: buildingValue,
    room: canonicalRoom(r.room),
    symptom: clampVocab<Symptom>(r.symptom, SYMPTOMS, 'unknown'),
    observedAt: normalizeObservedAt(r.observedAt, now),
    verbatim: sanitizeVerbatim(r.verbatim),
  };
}

/** Stage-1 entry point: keyword extraction, then the shared normalization. */
export function parseReport(text: string): ProblemReport {
  return normalize(extract(text));
}
