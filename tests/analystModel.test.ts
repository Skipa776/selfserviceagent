import { describe, expect, it } from 'vitest';

import type { ChatClient } from '../src/parser/chatClient';
import type { AnalystEvidenceSnapshot } from '../src/analyst/contracts';
import { createAnalystModel, buildAnalystPrompt } from '../src/analyst/model';

const snapshot: AnalystEvidenceSnapshot = {
  snapshotId: 'snap-1', generatedAt: '2026-09-11T12:05:00.000Z',
  topicKey: 'classroom_av|location|WLH||equipment_unavailable',
  service: 'classroom_av', scope: 'location', location: 'Lecture Hall West', building: 'WLH', room: '',
  symptom: 'equipment_unavailable', firstReportAt: '2026-09-11T12:00:00.000Z', lastReportAt: '2026-09-11T12:04:00.000Z',
  filedDistinct: 3, overflowDistinct: 2, overrideDistinct: 0, totalDistinct: 5,
  filedTicketNumbers: ['INC001'],
  evidence: [{ id: 'E1', correlationId: 'corr-1', reporterHash: 'r1', outcome: 'FILE_INCIDENT', ticketNumber: 'INC001', viaOverride: false, ts: '2026-09-11T12:00:00.000Z' }],
};

const response = JSON.stringify({
  shortDescription: 'Projector unavailable in Lecture Hall West',
  description: 'Five distinct synthetic reporters described matching classroom AV failures.',
  recommendedImpact: '2', recommendedUrgency: '2', evidenceStrength: 'sufficient',
  rationale: 'Five distinct reporters are represented in the evidence window.',
  citations: [{ claim: 'Five distinct reporters are represented.', evidenceIds: ['E1'] }],
  splitRecommendation: { shouldSplit: false, evidenceIds: ['E1'], rationale: 'One canonical topic is represented.' },
});

describe('analyst model', () => {
  it('sends aggregate evidence without reporter hashes or raw prose', () => {
    const prompt = JSON.stringify(buildAnalystPrompt(snapshot));
    expect(prompt).not.toContain('reporterHash');
    expect(prompt).not.toContain('r1');
    expect(prompt).toContain('filedDistinct');
    expect(prompt).toContain('E1');
  });

  it('returns a validated shadow proposal', async () => {
    const client: ChatClient = { complete: async () => response };
    const result = await createAnalystModel(client).propose(snapshot);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.recommendedImpact).toBe('2');
  });

  it('fails closed on invalid output without creating an authority fallback', async () => {
    const client: ChatClient = { complete: async () => '{"priority":"1"}' };
    expect(await createAnalystModel(client).propose(snapshot)).toEqual({
      ok: false,
      error: 'unexpected field priority',
    });
  });
});
