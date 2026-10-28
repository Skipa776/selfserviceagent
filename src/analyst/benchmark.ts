export type BenchmarkGate = {
  readonly minimumRows: number;
  readonly minimumRuns: number;
  readonly minimumFieldAccuracy: number;
  readonly minimumExactAccuracy: number;
  readonly maximumRepairRate: number;
  readonly maximumFallbackRate: number;
  readonly maximumProviderErrorRate: number;
};

export type ModelBenchmarkResult = {
  readonly modelId: string;
  readonly promptVersion: string;
  readonly corpusDigest: string;
  readonly measuredAt: string;
  readonly rows: number;
  readonly runs: number;
  readonly totalFields: number;
  readonly fieldFailures: number;
  readonly reportFailures: number;
  readonly repairAttempts: number;
  readonly fallbackAttempts: number;
  readonly providerErrors: number;
  readonly fieldAccuracy: number;
  readonly exactAccuracy: number;
  readonly repairRate: number;
  readonly fallbackRate: number;
  readonly providerErrorRate: number;
  readonly criticalFailures: number;
  readonly p50LatencyMs: number;
  readonly p95LatencyMs: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly countedPromptTokens: number;
  readonly tokenizerType: string;
};

export type BenchmarkGateReason =
  | 'passed'
  | 'gate_unconfigured'
  | 'critical_failure'
  | 'insufficient_rows'
  | 'insufficient_runs'
  | 'field_accuracy'
  | 'exact_accuracy'
  | 'repair_rate'
  | 'fallback_rate'
  | 'provider_error_rate';

export function evaluateBenchmarkGate(
  result: ModelBenchmarkResult,
  gate: BenchmarkGate | null,
): { allowed: boolean; reason: BenchmarkGateReason } {
  if (gate === null) return { allowed: false, reason: 'gate_unconfigured' };
  if (result.criticalFailures !== 0) return { allowed: false, reason: 'critical_failure' };
  if (result.rows < gate.minimumRows) return { allowed: false, reason: 'insufficient_rows' };
  if (result.runs < gate.minimumRuns) return { allowed: false, reason: 'insufficient_runs' };
  if (result.fieldAccuracy < gate.minimumFieldAccuracy) return { allowed: false, reason: 'field_accuracy' };
  if (result.exactAccuracy < gate.minimumExactAccuracy) return { allowed: false, reason: 'exact_accuracy' };
  if (result.repairRate > gate.maximumRepairRate) return { allowed: false, reason: 'repair_rate' };
  if (result.fallbackRate > gate.maximumFallbackRate) return { allowed: false, reason: 'fallback_rate' };
  if (result.providerErrorRate > gate.maximumProviderErrorRate) return { allowed: false, reason: 'provider_error_rate' };
  return { allowed: true, reason: 'passed' };
}
