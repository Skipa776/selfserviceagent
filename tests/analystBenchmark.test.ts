import { describe, expect, it } from 'vitest';

import { evaluateBenchmarkGate, type BenchmarkGate, type ModelBenchmarkResult } from '../src/analyst/benchmark';

const gate: BenchmarkGate = {
  minimumRows: 20,
  minimumRuns: 3,
  minimumFieldAccuracy: 0.98,
  minimumExactAccuracy: 0.95,
  maximumRepairRate: 0.05,
  maximumFallbackRate: 0.01,
  maximumProviderErrorRate: 0.01,
};

const result: ModelBenchmarkResult = {
  modelId: 'model-a',
  promptVersion: 'prompt-1',
  corpusDigest: 'corpus-1',
  measuredAt: '2026-09-11T12:00:00.000Z',
  rows: 26,
  runs: 5,
  totalFields: 780,
  fieldFailures: 0,
  reportFailures: 0,
  repairAttempts: 0,
  fallbackAttempts: 0,
  providerErrors: 0,
  fieldAccuracy: 1,
  exactAccuracy: 1,
  repairRate: 0,
  fallbackRate: 0,
  providerErrorRate: 0,
  criticalFailures: 0,
  p50LatencyMs: 100,
  p95LatencyMs: 200,
  promptTokens: 100,
  completionTokens: 20,
  totalTokens: 120,
  countedPromptTokens: 100,
  tokenizerType: 'test-tokenizer',
};

describe('analyst model benchmark gate', () => {
  it('fails closed when no approved gate exists', () => {
    expect(evaluateBenchmarkGate(result, null)).toEqual({ allowed: false, reason: 'gate_unconfigured' });
  });

  it('allows a model only when every configured boundary passes', () => {
    expect(evaluateBenchmarkGate(result, gate)).toEqual({ allowed: true, reason: 'passed' });
  });

  it.each([
    ['criticalFailures', 1, 'critical_failure'],
    ['rows', 19, 'insufficient_rows'],
    ['runs', 2, 'insufficient_runs'],
    ['fieldAccuracy', 0.97, 'field_accuracy'],
    ['exactAccuracy', 0.94, 'exact_accuracy'],
    ['repairRate', 0.06, 'repair_rate'],
    ['fallbackRate', 0.02, 'fallback_rate'],
    ['providerErrorRate', 0.02, 'provider_error_rate'],
  ] as const)('rejects %s outside its boundary', (field, value, reason) => {
    expect(evaluateBenchmarkGate({ ...result, [field]: value }, gate)).toEqual({ allowed: false, reason });
  });

  it('passes equality at every inclusive boundary', () => {
    expect(evaluateBenchmarkGate({
      ...result,
      rows: gate.minimumRows,
      runs: gate.minimumRuns,
      fieldAccuracy: gate.minimumFieldAccuracy,
      exactAccuracy: gate.minimumExactAccuracy,
      repairRate: gate.maximumRepairRate,
      fallbackRate: gate.maximumFallbackRate,
      providerErrorRate: gate.maximumProviderErrorRate,
    }, gate).allowed).toBe(true);
  });
});
