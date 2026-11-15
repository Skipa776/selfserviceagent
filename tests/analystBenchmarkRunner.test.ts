import { describe, expect, it } from 'vitest';

import { benchmarkParserModels, corpusDigest } from '../src/analyst/benchmarkRunner';
import type { EvalRow } from './corpus';
import { fakeCreateMessage, toolUseMessage } from './llmFixtures';

const row: EvalRow = {
  id: 'av-lhw', groupId: 'av-lhw', role: 'faculty', input: 'Projector in LHW is down',
  service: 'classroom_av', scope: 'location', location: 'Lecture Hall West', building: 'LHW', room: '',
  symptom: 'equipment_unavailable',
};

const answer = (): ReturnType<typeof toolUseMessage> => toolUseMessage({
  service: 'classroom_av', scope: 'location', location: 'Lecture Hall West', building: 'LHW', room: '',
  symptom: 'equipment_unavailable', observedAt: '',
});

describe('multi-model parser benchmark', () => {
  it('evaluates each named model against the same corpus and records model identity', async () => {
    const results = await benchmarkParserModels({
      models: [
        { id: 'model-a', createMessage: fakeCreateMessage(answer(), answer()) },
        { id: 'model-b', createMessage: fakeCreateMessage(answer(), answer()) },
      ],
      rows: [row], runs: 2,
      now: () => new Date('2026-09-11T12:00:00.000Z'),
    });
    expect(results.map((result) => result.modelId)).toEqual(['model-a', 'model-b']);
    expect(results.every((result) => result.fieldAccuracy === 1 && result.exactAccuracy === 1)).toBe(true);
    expect(results.every((result) => result.totalFields === 12 && result.fieldFailures === 0 && result.reportFailures === 0)).toBe(true);
    expect(results.every((result) => result.corpusDigest === corpusDigest([row]))).toBe(true);
    expect(results[0].samples).toEqual([{ rowId: 'av-lhw', input: row.input, output: {
      service: 'classroom_av', scope: 'location', location: 'Lecture Hall West', building: 'LHW', room: '',
      symptom: 'equipment_unavailable', observedAt: '', verbatim: row.input,
    }, source: 'llm', repairAttempted: false, exact: true, misses: [] }]);
  });

  it('sums token usage from every response, repairs included', async () => {
    // The hand-built responses each report 1200 input / 60 output tokens.
    const [result] = await benchmarkParserModels({
      models: [{ id: 'metered', createMessage: fakeCreateMessage(answer()) }], rows: [row], runs: 1,
    });
    expect(result).toMatchObject({ promptTokens: 1200, completionTokens: 60, totalTokens: 1260 });
  });

  it('counts fallback as a reliability failure without hiding the parsed result', async () => {
    const [result] = await benchmarkParserModels({
      models: [{ id: 'offline', createMessage: fakeCreateMessage(null) }], rows: [row], runs: 1,
    });
    expect(result.fallbackRate).toBe(1);
    expect(result.providerErrorRate).toBe(1);
    expect(result).toMatchObject({ repairAttempts: 0, fallbackAttempts: 1, providerErrors: 1 });
  });
});
