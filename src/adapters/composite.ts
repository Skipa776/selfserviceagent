// One IncidentSource over several, because stage 2 genuinely has two.
//
// adapters.md, stage 2: "`IncidentSource` reads peer tickets back from the PDI;
// declared incidents stay fixtures unless a read-only real feed exists." No such
// feed is confirmed, so the local integration is honestly half-real:
// peer tickets come from ServiceNow, declared incidents from fixtures.
//
// Without this, wiring the PDI would silently delete the declared-incident
// branch from the stage-2 demo — and that branch is half the decision rule and
// the ONLY one that deflects at match #1. A stage-2 demo
// that can no longer show F1 would be a regression dressed as progress.
//
// It adds no capability: the merged result is the same MatchCandidate[] the
// interface already promises, sorted the same way. Nothing above the adapter
// layer knows there are two sources, which is the property that lets stage 3
// collapse them back into one when ITS names the real feed.

import type { IncidentSource } from '../contracts/adapters';
import type { MatchCandidate } from '../contracts/types';
import type { SearchQuery } from './scoring';

export class CompositeIncidentSource implements IncidentSource {
  constructor(private readonly sources: readonly IncidentSource[]) {}

  async search(q: SearchQuery): Promise<MatchCandidate[]> {
    // NOT Promise.allSettled. A source that fails must fail the whole search —
    // A failed incident search must never fall through to filing: "the
    // search is most likely to be down during exactly the incident that would
    // have deflected the report." Swallowing one source's failure would return a
    // partial result that looks like a complete one, and the orchestrator would
    // file instead of returning UNAVAILABLE. That is the flood this feature
    // exists to prevent, arriving through a helpful-looking catch block.
    const results = await Promise.all(this.sources.map((s) => s.search(q)));

    return results.flat().sort((a, b) => b.matchScore - a.matchScore);
  }
}
