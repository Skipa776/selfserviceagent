// `npm run eval:models` — runs the shipping parser (same prompt, same forced
// tool) against several Claude models on the synthetic corpus. Live network
// call; never part of `npm test`.
//
//   ANALYST_MODELS="claude-haiku-5-5,claude-sonnet-5" LLM_EVAL_RUNS=3 npm run eval:models
//
// Only models that accept a forced tool_choice can run this request. Claude
// Opus 5.5, Sonnet 5.5 and Fable 5.x reject it (HTTP 400), so they would show
// up here as 100% provider errors, not as a parsing result.

import { writeFile } from 'node:fs/promises';

import { benchmarkParserModels, corpusDigest } from '../src/analyst/benchmarkRunner';
import { createMessageFromEnv, PARSER_MODEL, type CreateMessage } from '../src/parser/llmParser';
import { EVAL_ROWS } from '../tests/corpus';

async function main(): Promise<number> {
  const createMessage = createMessageFromEnv();
  if (createMessage === null) {
    process.stderr.write('Set ANTHROPIC_API_KEY to compare parser models.\n');
    return 1;
  }
  const modelIds = process.env.ANALYST_MODELS?.split(',').map((model) => model.trim()).filter(Boolean) ?? [PARSER_MODEL];
  const runs = Number.parseInt(process.env.LLM_EVAL_RUNS ?? '3', 10);
  // Same request the parser builds, sent to a different model.
  const models = modelIds.map((id) => {
    const toModel: CreateMessage = (params) => createMessage({ ...params, model: id });
    return { id, createMessage: toModel };
  });
  const results = await benchmarkParserModels({ models, rows: EVAL_ROWS, runs });
  const artifact = {
    measuredAt: new Date().toISOString(),
    corpusDigest: corpusDigest(EVAL_ROWS),
    rows: EVAL_ROWS.length,
    runs,
    results,
  };
  const output = process.env.ANALYST_BENCHMARK_OUTPUT?.trim() || 'analyst-model-benchmark.json';
  await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n\nWrote ${output}\n`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`benchmark failed: ${error instanceof Error ? error.message : 'unknown'}\n`);
    process.exit(1);
  },
);
