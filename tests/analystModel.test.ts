import { describe, expect, it } from 'vitest';

import { llmChatClient, type ChatClient } from '../src/parser/chatClient';
import type { AnalystEvidenceSnapshot } from '../src/analyst/contracts';
import { buildAnalystPrompt, createAnalystModel, extractFirstJsonObject } from '../src/analyst/model';

const snapshot: AnalystEvidenceSnapshot = {
  snapshotId: 'snap-1', generatedAt: '2026-09-11T12:05:00.000Z',
  topicKey: 'classroom_av|location|LHW||equipment_unavailable',
  service: 'classroom_av', scope: 'location', location: 'Lecture Hall West', building: 'LHW', room: '',
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

// Text-model output shapes the analyst proposal model must survive.
const CLEAN_JSON = JSON.stringify({ service: 'wifi', location: 'North Residence Hall' });
const PROSE_WRAPPED = `Sure! Here's the extracted information:\n\n${CLEAN_JSON}\n\nLet me know.`;
const FENCED = '```json\n' + CLEAN_JSON + '\n```';
const NO_JSON = 'It sounds like the wifi in North Residence Hall is unstable. Try reconnecting.';
const TRUNCATED = '{"service": "wifi", "scope": "loc';

describe('extractFirstJsonObject', () => {
  it('reads a bare JSON object', () => {
    expect(extractFirstJsonObject(CLEAN_JSON)).toMatchObject({ service: 'wifi' });
  });

  it('extracts JSON from prose', () => {
    expect(extractFirstJsonObject(PROSE_WRAPPED)).toMatchObject({ service: 'wifi', location: 'North Residence Hall' });
  });

  it('extracts JSON from a code fence', () => {
    expect(extractFirstJsonObject(FENCED)).toMatchObject({ service: 'wifi', location: 'North Residence Hall' });
  });

  it('returns null on unparseable output, and never throws', () => {
    expect(() => extractFirstJsonObject(NO_JSON)).not.toThrow();
    expect(() => extractFirstJsonObject('{bad}')).not.toThrow();
    expect(extractFirstJsonObject(NO_JSON)).toBeNull();
    expect(extractFirstJsonObject('{bad}')).toBeNull();
    expect(extractFirstJsonObject(TRUNCATED)).toBeNull();
    expect(extractFirstJsonObject('')).toBeNull();
  });

  it('ignores braces inside strings, including escaped quotes and backslashes', () => {
    const response = JSON.stringify({
      service: 'wifi',
      scope: 'location',
      location: 'North Residence Hall',
      building: 'NORTH RESIDENCE HALL',
      room: '',
      symptom: 'intermittent',
      observedAt: '',
    });
    const candidate = extractFirstJsonObject(`Result: ${response} trailing prose`);

    expect(candidate).not.toBeNull();
    expect(candidate).toMatchObject({ location: 'North Residence Hall' });
  });
});

describe('the analyst text client', () => {
  it('omits temperature for models that reject the parameter', async () => {
    let body: Record<string, unknown> = {};
    const original = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200 });
    };
    try {
      const client = llmChatClient({ url: 'https://example.invalid', key: 'synthetic', model: 'gpt-5.6-luna', timeoutMs: 1000 });
      await client.complete([{ role: 'user', content: 'test' }]);
      expect(body).not.toHaveProperty('temperature');
    } finally {
      globalThis.fetch = original;
    }
  });
});
