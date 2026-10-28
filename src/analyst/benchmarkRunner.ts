import { createHash } from 'node:crypto';

import type { ChatClient } from '../parser/chatClient';
import { buildPrompt, createLlmParser, schemaFromCatalog } from '../parser/llmParser';
import type { EvalRow } from '../../tests/corpus';
import { gradeRow, groupingKey } from '../../tests/grade';
import type { ModelBenchmarkResult } from './benchmark';

export const ANALYST_PARSER_PROMPT_VERSION = createHash('sha256')
  .update(JSON.stringify({ prompt: buildPrompt('__benchmark_input__')[0], schema: schemaFromCatalog() }))
  .digest('hex');

export type BenchmarkModel = {
  readonly id: string;
  readonly client: ChatClient;
  readonly countPromptTokens?: (messages: readonly import('../parser/chatClient').ChatMessage[]) => Promise<{
    totalTokens: number;
    tokenizerType: string;
  }>;
};

export type TimedModelBenchmarkResult = ModelBenchmarkResult & {
  readonly totalAttempts: number;
  readonly samples: readonly {
    readonly rowId: string;
    readonly input: string;
    readonly output: Awaited<ReturnType<ReturnType<typeof createLlmParser>['parse']>>['report'];
    readonly source: 'llm' | 'keyword';
    readonly repairAttempted: boolean;
    readonly exact: boolean;
    readonly misses: readonly string[];
  }[];
};

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.ceil(ordered.length * fraction) - 1] ?? ordered.at(-1) ?? 0;
}

export function corpusDigest(rows: readonly EvalRow[]): string {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

export async function benchmarkParserModels(input: {
  readonly models: readonly BenchmarkModel[];
  readonly rows: readonly EvalRow[];
  readonly runs: number;
  readonly now?: () => Date;
}): Promise<TimedModelBenchmarkResult[]> {
  if (!Number.isInteger(input.runs) || input.runs < 1) throw new Error('runs must be a positive integer');
  const now = input.now ?? (() => new Date());
  const digest = corpusDigest(input.rows);
  const results: TimedModelBenchmarkResult[] = [];

  for (const model of input.models) {
    const usageBefore = model.client.usage?.() ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let providerErrors = 0;
    const measuredClient: ChatClient = {
      async complete(messages) {
        try {
          return await model.client.complete(messages);
        } catch (error) {
          providerErrors++;
          throw error;
        }
      },
    };
    const parser = createLlmParser({ client: measuredClient, now });
    let correct = 0;
    let exact = 0;
    let repairs = 0;
    let fallbacks = 0;
    let criticalFailures = 0;
    const latencies: number[] = [];
    let countedPromptTokens = 0;
    let tokenizerType = 'provider-usage-only';
    const samples: TimedModelBenchmarkResult['samples'][number][] = [];

    for (let run = 0; run < input.runs; run++) {
      for (const row of input.rows) {
        if (run === 0 && model.countPromptTokens !== undefined) {
          const counted = await model.countPromptTokens(buildPrompt(row.input));
          countedPromptTokens += counted.totalTokens;
          tokenizerType = counted.tokenizerType;
        }
        const startedAt = performance.now();
        const parsed = await parser.parse(row.input);
        latencies.push(performance.now() - startedAt);
        const fields = gradeRow(row, parsed.report);
        if (run === 0) {
          samples.push({
            rowId: row.id,
            input: row.input,
            output: parsed.report,
            source: parsed.source,
            repairAttempted: parsed.repairAttempted === true,
            exact: fields.every((field) => field.ok),
            misses: fields.filter((field) => !field.ok).map((field) => `${field.field}: expected ${field.expected}, got ${field.actual}`),
          });
        }
        correct += fields.filter((field) => field.ok).length;
        if (fields.every((field) => field.ok)) exact++;
        if (parsed.repairAttempted === true) repairs++;
        if (parsed.source === 'keyword') fallbacks++;
        const expectedService = typeof row.service === 'string' ? row.service : 'unknown';
        if (
          parsed.report.scope !== row.scope ||
          parsed.report.building !== row.building ||
          parsed.report.room !== row.room ||
          groupingKey(parsed.report) !== groupingKey({
            service: expectedService,
            scope: row.scope,
            building: row.building,
            room: row.room,
          })
        ) criticalFailures++;
      }
    }

    const attempts = input.rows.length * input.runs;
    const usageAfter = model.client.usage?.() ?? usageBefore;
    results.push({
      modelId: model.id,
      promptVersion: ANALYST_PARSER_PROMPT_VERSION,
      corpusDigest: digest,
      measuredAt: now().toISOString(),
      rows: input.rows.length,
      runs: input.runs,
      totalFields: attempts * 6,
      fieldFailures: (attempts * 6) - correct,
      reportFailures: attempts - exact,
      repairAttempts: repairs,
      fallbackAttempts: fallbacks,
      providerErrors,
      fieldAccuracy: attempts === 0 ? 0 : correct / (attempts * 6),
      exactAccuracy: attempts === 0 ? 0 : exact / attempts,
      repairRate: attempts === 0 ? 0 : repairs / attempts,
      fallbackRate: attempts === 0 ? 0 : fallbacks / attempts,
      providerErrorRate: attempts === 0 ? 0 : providerErrors / attempts,
      criticalFailures,
      p50LatencyMs: percentile(latencies, 0.5),
      p95LatencyMs: percentile(latencies, 0.95),
      totalAttempts: attempts,
      promptTokens: usageAfter.promptTokens - usageBefore.promptTokens,
      completionTokens: usageAfter.completionTokens - usageBefore.completionTokens,
      totalTokens: usageAfter.totalTokens - usageBefore.totalTokens,
      countedPromptTokens,
      tokenizerType,
      samples,
    });
  }

  return results;
}
