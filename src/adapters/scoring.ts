// The match scorer — ONE formula, shared by every IncidentSource implementation.
//
// Extracted from memory.ts at stage 2, when the ServiceNow adapter needed it.
// Not a refactor for tidiness: tests/test_matrix.md's stage-parity row requires
// that "every flow produces the same outcome under stage-1 and stage-2 wiring",
// and two scorers against one injected threshold (cluster_gate.md) would break
// that silently — a report that deflects at stage 1 files at stage 2, with
// nothing in either codebase looking wrong. The threshold is a single number
// applied to whatever score comes back, so the score has to mean the same thing
// whoever produced it.
//
// match_candidate.md: matchScore is "computed by the adapter, not the source".
// That stays true — this is still adapter-side. What it is not is
// adapter-SPECIFIC.

import type { MatchCandidate } from '../contracts/types';

export type SearchQuery = {
  service: string;
  location: string;
  building: string;
  room: string;
  scope: string;
  symptom: string;
};

/**
 * Scores one candidate against the query. Deterministic: the same query against
 * the same candidate always returns the same score, without which the
 * cluster_gate.md boundary tests mean nothing.
 *
 * Scope disagreement is DISQUALIFYING: cluster evidence is per service/scope,
 * so an individual ticket cannot cover a location- or service-wide report.
 * For location-scoped reports, named-location disagreement is also
 * disqualifying — a declared incident about South Residence Hall does not cover North Residence Hall however
 * well service and symptom line up (report_corpus.md F6).
 *
 * This baseline has known limits: no exact location tokens, building-to-area
 * hierarchy, or service-CI relationships. Real granularity remains unresolved
 * from real data; replace this function without changing callers. Sharing
 * it across adapters does not make the temporary formula the matching spec.
 */
export function scoreCandidate(q: SearchQuery, c: MatchCandidate): number {
  if (c.scope !== q.scope) return 0;

  const namesLocations = q.location !== '' && c.locations.length > 0;
  if (q.scope === 'location' && namesLocations && !c.locations.includes(q.location)) return 0;
  if (q.location !== '' && (c.building === '' || c.building !== q.building)) return 0;
  if (q.service === 'classroom_av' && q.scope === 'location' && c.room !== q.room) return 0;

  return 0.7 + (c.symptom === q.symptom ? 0.3 : 0);
}
