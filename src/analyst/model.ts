import type { ChatClient, ChatMessage } from '../parser/chatClient';
import type { AnalystEvidenceSnapshot, AnalystProposal } from './contracts';
import { validateAnalystProposal } from './proposal';

/**
 * Parses the first balanced JSON object from bare, fenced, or prose-wrapped
 * output. Braces inside strings are ignored, and malformed JSON returns null.
 */
export function extractFirstJsonObject(raw: string): unknown {
  const start = raw.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const character = raw[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      depth++;
    } else if (character === '}') {
      depth--;
    }

    if (depth === 0) {
      try {
        return JSON.parse(raw.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }

  return null;
}

export function buildAnalystPrompt(snapshot: AnalystEvidenceSnapshot): ChatMessage[] {
  const evidence = snapshot.evidence.map(({ id, outcome, ticketNumber, viaOverride, ts }) => ({
    id,
    outcome,
    ticketNumber,
    viaOverride,
    ts,
  }));
  const aggregate = {
    snapshotId: snapshot.snapshotId,
    service: snapshot.service,
    scope: snapshot.scope,
    location: snapshot.location,
    building: snapshot.building,
    room: snapshot.room,
    symptom: snapshot.symptom,
    firstReportAt: snapshot.firstReportAt,
    lastReportAt: snapshot.lastReportAt,
    filedDistinct: snapshot.filedDistinct,
    overflowDistinct: snapshot.overflowDistinct,
    overrideDistinct: snapshot.overrideDistinct,
    totalDistinct: snapshot.totalDistinct,
    filedTicketNumbers: snapshot.filedTicketNumbers,
    evidence,
  };
  return [
    {
      role: 'system',
      content:
        'You are an advisory incident analyst. Return only JSON with exactly these fields: ' +
        'shortDescription, description, recommendedImpact, recommendedUrgency, evidenceStrength, rationale, citations, splitRecommendation. ' +
        "recommendedImpact and recommendedUrgency must be '1', '2', or '3'. evidenceStrength must be insufficient, limited, or sufficient. " +
        'Every claim must cite supplied evidence IDs. You may recommend a split but cannot create, update, prioritize, or declare an incident. ' +
        'Never claim an outage, cause, ETA, remediation, progress, assignment, or service status. Peer reports are evidence only. ' +
        'Use this exact shape: ' + JSON.stringify({
          shortDescription: 'Bounded summary',
          description: 'Evidence-only description',
          recommendedImpact: '2',
          recommendedUrgency: '2',
          evidenceStrength: 'limited',
          rationale: 'Evidence-only rationale',
          citations: [{ claim: 'Claim supported by evidence.', evidenceIds: ['E1'] }],
          splitRecommendation: { shouldSplit: false, evidenceIds: ['E1'], rationale: 'Evidence-only rationale' },
        }) + '.',
    },
    { role: 'user', content: JSON.stringify(aggregate) },
  ];
}

export function createAnalystModel(client: ChatClient): {
  propose(snapshot: AnalystEvidenceSnapshot): Promise<
    { ok: true; value: AnalystProposal } | { ok: false; error: string }
  >;
} {
  return {
    async propose(snapshot) {
      try {
        const raw = await client.complete(buildAnalystPrompt(snapshot));
        const parsed = extractFirstJsonObject(raw);
        const first = validateAnalystProposal(parsed, snapshot);
        if (first.ok) return first;
        const repaired = await client.complete([
          ...buildAnalystPrompt(snapshot),
          {
            role: 'user',
            content: `Your previous response was invalid: ${first.error}. Return only a corrected JSON object in the exact requested shape.`,
          },
        ]);
        return validateAnalystProposal(extractFirstJsonObject(repaired), snapshot);
      } catch {
        return { ok: false, error: 'analyst model unavailable' };
      }
    },
  };
}
