import { describe, expect, it } from 'vitest';

import { benchmarkParserModels, corpusDigest } from '../src/analyst/benchmarkRunner';
import { llmChatClient } from '../src/parser/chatClient';
import type { ChatClient } from '../src/parser/chatClient';
import type { EvalRow } from './corpus';

const row: EvalRow = {
  id: 'av-wlh', groupId: 'av-wlh', role: 'faculty', input: 'Projector in WLH is down',
  service: 'classroom_av', scope: 'location', location: 'Lecture Hall West', building: 'WLH', room: '',
  symptom: 'equipment_unavailable',
};

const answer = JSON.stringify({
  service: 'classroom_av', scope: 'location', location: 'Lecture Hall West', building: 'WLH', room: '',
  symptom: 'equipment_unavailable', observedAt: '',
});

describe('multi-model parser benchmark', () => {
  it('omits temperature for models that reject the parameter', async () => {
    let body: Record<string, unknown> = {};
    const original = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: answer } }] }), { status: 200 });
    };
    try {
      const client = llmChatClient({ url: 'https://example.invalid', key: 'synthetic', model: 'gpt-5.6-luna', timeoutMs: 1000 });
      await client.complete([{ role: 'user', content: 'test' }]);
      expect(body).not.toHaveProperty('temperature');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('evaluates each named model against the same corpus and records model identity', async () => {
    const client: ChatClient = { complete: async () => answer };
    const results = await benchmarkParserModels({
      models: [{ id: 'model-a', client }, { id: 'model-b', client }], rows: [row], runs: 2,
      now: () => new Date('2026-09-11T12:00:00.000Z'),
    });
    expect(results.map((result) => result.modelId)).toEqual(['model-a', 'model-b']);
    expect(results.every((result) => result.fieldAccuracy === 1 && result.exactAccuracy === 1)).toBe(true);
    expect(results.every((result) => result.totalFields === 12 && result.fieldFailures === 0 && result.reportFailures === 0)).toBe(true);
    expect(results.every((result) => result.corpusDigest === corpusDigest([row]))).toBe(true);
    expect(results[0].samples).toEqual([{ rowId: 'av-wlh', input: row.input, output: {
      service: 'classroom_av', scope: 'location', location: 'Lecture Hall West', building: 'WLH', room: '',
      symptom: 'equipment_unavailable', observedAt: '', verbatim: row.input,
    }, source: 'llm', repairAttempted: false, exact: true, misses: [] }]);
    expect(results[0]).toMatchObject({ promptTokens: 0, completionTokens: 0, totalTokens: 0, countedPromptTokens: 0 });
  });

  it('aggregates token usage returned by the provider', async () => {
    let calls = 0;
    const client: ChatClient = {
      complete: async () => { calls++; return answer; },
      usage: () => ({ promptTokens: calls * 120, completionTokens: calls * 30, totalTokens: calls * 150 }),
    };
    const [result] = await benchmarkParserModels({ models: [{ id: 'metered', client }], rows: [row], runs: 1 });
    expect(result).toMatchObject({ promptTokens: 120, completionTokens: 30, totalTokens: 150 });
  });

  it('records prompt tokens from the LLM provider token counting independently', async () => {
    const client: ChatClient = { complete: async () => answer };
    const [result] = await benchmarkParserModels({
      models: [{ id: 'counted', client, countPromptTokens: async () => ({ totalTokens: 321, tokenizerType: 'test' }) }],
      rows: [row], runs: 1,
    });
    expect(result).toMatchObject({ countedPromptTokens: 321, tokenizerType: 'test' });
  });

  it('counts fallback as a reliability failure without hiding the parsed result', async () => {
    const client: ChatClient = { complete: async () => { throw new Error('offline'); } };
    const [result] = await benchmarkParserModels({ models: [{ id: 'offline', client }], rows: [row], runs: 1 });
    expect(result.fallbackRate).toBe(1);
    expect(result.providerErrorRate).toBe(1);
    expect(result).toMatchObject({ repairAttempts: 0, fallbackAttempts: 1, providerErrors: 1 });
  });
});
