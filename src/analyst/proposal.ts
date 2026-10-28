import {
  EVIDENCE_STRENGTHS,
  IMPACT_VALUES,
  URGENCY_VALUES,
  type AnalystEvidenceSnapshot,
  type AnalystProposal,
} from './contracts';

const FIELDS = [
  'shortDescription',
  'description',
  'recommendedImpact',
  'recommendedUrgency',
  'evidenceStrength',
  'rationale',
  'citations',
  'splitRecommendation',
] as const;

const PROHIBITED_CLAIMS = [
  /\boutage\b/i,
  /\b(?:service|network|wifi|wi-fi|vpn|portal|canvas) (?:is|are|appears?|seems?) (?:currently )?(?:down|unavailable|degraded)\b/i,
  /\b(?:IT (?:staff|team)|support|engineers?|technicians?|vendor) (?:has|have|is|are|was|were)?\s*(?:been\s+)?(?:confirmed|investigating|assigned|working|diagnosed)/i,
  /\b(?:caused by|confirmed (?:hardware|software) failure|root cause (?:is|was))\b/i,
  /\b(?:restore|restored|restoration|resolved|resolution)\b/i,
  /\bETA\b/i,
];

const MAX_SHORT_DESCRIPTION = 160;
const MAX_DESCRIPTION = 2_000;
const MAX_RATIONALE = 1_000;
const MAX_CITATIONS = 20;
const MAX_CLAIM = 500;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value === value.trim();
}

function containsProhibitedClaim(value: string): boolean {
  return PROHIBITED_CLAIMS.some((pattern) => pattern.test(value));
}

export function validateAnalystProposal(
  raw: unknown,
  snapshot: AnalystEvidenceSnapshot,
): { ok: true; value: AnalystProposal } | { ok: false; error: string } {
  const candidate = record(raw);
  if (candidate === null) return { ok: false, error: 'proposal is not an object' };
  const unexpected = Object.keys(candidate).find((field) => !(FIELDS as readonly string[]).includes(field));
  if (unexpected !== undefined) return { ok: false, error: `unexpected field ${unexpected}` };

  for (const field of ['shortDescription', 'description', 'rationale'] as const) {
    if (!nonEmpty(candidate[field])) return { ok: false, error: `field ${field} must be a nonempty string` };
    if (containsProhibitedClaim(candidate[field])) return { ok: false, error: `field ${field} contains a prohibited claim` };
  }
  if ((candidate.shortDescription as string).length > MAX_SHORT_DESCRIPTION) {
    return { ok: false, error: 'shortDescription is too long' };
  }
  if ((candidate.description as string).length > MAX_DESCRIPTION) {
    return { ok: false, error: 'description is too long' };
  }
  if ((candidate.rationale as string).length > MAX_RATIONALE) {
    return { ok: false, error: 'rationale is too long' };
  }
  if (!(IMPACT_VALUES as readonly unknown[]).includes(candidate.recommendedImpact)) {
    return { ok: false, error: 'recommendedImpact is invalid' };
  }
  if (!(URGENCY_VALUES as readonly unknown[]).includes(candidate.recommendedUrgency)) {
    return { ok: false, error: 'recommendedUrgency is invalid' };
  }
  if (!(EVIDENCE_STRENGTHS as readonly unknown[]).includes(candidate.evidenceStrength)) {
    return { ok: false, error: 'evidenceStrength is invalid' };
  }

  if (!Array.isArray(candidate.citations) || candidate.citations.length === 0 || candidate.citations.length > MAX_CITATIONS) {
    return { ok: false, error: 'citations must be a nonempty array' };
  }
  const allowedIds = new Set(snapshot.evidence.map((item) => item.id));
  const citations: Array<{ claim: string; evidenceIds: string[] }> = [];
  for (const rawCitation of candidate.citations) {
    const citation = record(rawCitation);
    if (citation === null || !nonEmpty(citation.claim) || !Array.isArray(citation.evidenceIds) || citation.evidenceIds.length === 0) {
      return { ok: false, error: 'citation is invalid' };
    }
    if (citation.claim.length > MAX_CLAIM || containsProhibitedClaim(citation.claim)) {
      return { ok: false, error: 'citation claim is invalid' };
    }
    const evidenceIds = citation.evidenceIds;
    if (!evidenceIds.every(nonEmpty)) return { ok: false, error: 'citation evidence ID is invalid' };
    const unknown = evidenceIds.find((id) => !allowedIds.has(id));
    if (unknown !== undefined) return { ok: false, error: `citation ${unknown} is not in snapshot` };
    citations.push({ claim: citation.claim, evidenceIds: [...new Set(evidenceIds)] });
  }

  const split = record(candidate.splitRecommendation);
  if (split === null || typeof split.shouldSplit !== 'boolean' || !nonEmpty(split.rationale) || !Array.isArray(split.evidenceIds)) {
    return { ok: false, error: 'splitRecommendation is invalid' };
  }
  if (containsProhibitedClaim(split.rationale)) return { ok: false, error: 'splitRecommendation contains a prohibited claim' };
  if (split.rationale.length > MAX_RATIONALE) return { ok: false, error: 'splitRecommendation is too long' };
  if (split.shouldSplit && split.evidenceIds.length === 0) return { ok: false, error: 'splitRecommendation requires evidence' };
  if (!split.evidenceIds.every(nonEmpty)) return { ok: false, error: 'split evidence ID is invalid' };
  const unknownSplit = split.evidenceIds.find((id) => !allowedIds.has(id));
  if (unknownSplit !== undefined) return { ok: false, error: `citation ${unknownSplit} is not in snapshot` };

  return {
    ok: true,
    value: {
      snapshotId: snapshot.snapshotId,
      shortDescription: candidate.shortDescription as string,
      description: candidate.description as string,
      recommendedImpact: candidate.recommendedImpact as AnalystProposal['recommendedImpact'],
      recommendedUrgency: candidate.recommendedUrgency as AnalystProposal['recommendedUrgency'],
      evidenceStrength: candidate.evidenceStrength as AnalystProposal['evidenceStrength'],
      rationale: candidate.rationale as string,
      citations,
      splitRecommendation: {
        shouldSplit: split.shouldSplit,
        evidenceIds: [...new Set(split.evidenceIds as string[])],
        rationale: split.rationale,
      },
    },
  };
}
