// decide.ts — the routing DECISION (decision.md). The single highest-risk
// function in the system, and the one the whole architecture exists to protect.
//
// PURE. Given the same (report, evidence, override) and the same injected gate
// tuning, it returns the same outcome — every time, forever. It reads no clock,
// calls no LLM, touches no adapter, does no I/O. The orchestrator has already
// reduced every MatchCandidate down to booleans and counts before calling this, so
// there is nothing in scope here to be tempted by: no summary to quote, no
// timestamp to re-derive, no network to reach for.
//
// It is also BYTE-IDENTICAL across all three stages (decision.md, "# Stages"). If a
// future stage change edits this file, the seam was drawn in the wrong place — the
// probabilistic parser is what changes between stages, never the decision.

import type { Decision, ProblemReport } from './contracts/types';
import { gateTuning } from './clusterGate';

/**
 * The reduced match evidence the orchestrator passes in (decision.md, step REDUCE).
 * Deliberately NOT a MatchCandidate: by the time evidence reaches decide() the
 * quotable fields are gone, so decide() *cannot* leak a status or a summary into its
 * result even if someone tried. `withinWindow` arrives pre-computed as a boolean —
 * the orchestrator owns the clock and applied MATCH_TIME_WINDOW_MINUTES; decide()
 * never sees a timestamp (that's why it can be pure).
 */
export type Evidence = {
  /** The single authoritative declared incident that matched, or null. No count:
   *  one declared incident outranks any volume of peers. */
  readonly declared: {
    readonly matchScore: number;
    readonly withinWindow: boolean;
  } | null;
  /** The peer cluster, or null. `distinctReporters` is already de-duplicated by
   *  reporterHash — raw ticket count never reaches here (boundaries.md: 5 reports
   *  from one person is not a cluster). */
  readonly peers: {
    readonly matchScore: number;
    readonly withinWindow: boolean;
    readonly distinctReporters: number;
     /** The per-topic existing-cluster ceiling the orchestrator resolved via
      *  thresholdFor() (clusterGate.ts). Injected as part of evidence — exactly
      *  like `withinWindow` — so decide() stays pure and holds no threshold literal
     *  of its own. This count is the number of matching distinct reporters ALREADY
     *  on the record from search results. Deflect when that existing count reaches
     *  the ceiling: threshold 5 means "5 existing matching tickets is enough to
     *  suppress creating the next one". */
    readonly clusterThreshold: number;
  } | null;
};

export function decide(report: ProblemReport, evidence: Evidence, override: boolean): Decision {
  // Plumbing: the score threshold you compare against in branches 2 & 3. It is the
  // UNSET MATCH_SCORE_THRESHOLD, injected via configureGate() — decide() reads it,
  // never defaults it. The COUNT threshold is no longer a module constant here: it
  // is per-topic and arrives pre-resolved in evidence.peers.clusterThreshold, the
  // same way withinWindow arrives pre-computed. The peer count is EXISTING peers
  // from search, so deflection begins when that existing count reaches the ceiling.
  // decide() holds no threshold literal.
  const { matchScoreThreshold } = gateTuning();

  const fileOutcome =report.scope === 'individual' || report.scope === 'unknown' ? 'FILE_REQUEST' : 'FILE_INCIDENT';

  if (override === true){
    return {outcome: fileOutcome, reason: 'override'};
  }

  if (
    evidence.declared !== null &&
    evidence.declared.matchScore >= matchScoreThreshold &&
    evidence.declared.withinWindow
  ) {
    return {
      outcome: 'MATCHED_DECLARED',
      reason: 'declared_in_window'
    };
  }
  
  if (
    evidence.peers !== null &&
    evidence.peers.matchScore >= matchScoreThreshold &&
    evidence.peers.withinWindow &&
    evidence.peers.distinctReporters >= evidence.peers.clusterThreshold
  ) {
    return {
      outcome: 'MATCHED_CLUSTER',
      reason: 'cluster_ge_threshold',
    };
  }

  return {
    outcome: fileOutcome,
    reason: 'no_match'
  };
}
