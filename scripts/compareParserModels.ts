import { writeFile } from 'node:fs/promises';

import { benchmarkParserModels, corpusDigest } from '../src/analyst/benchmarkRunner';
import { countLlmTokens, llmChatClient, llmConfigFromEnv } from '../src/parser/chatClient';
import { EVAL_ROWS } from '../tests/corpus';

async function main(): Promise<number> {
  const configuredModels = process.env.ANALYST_MODELS?.split(',').map((model) => model.trim()).filter(Boolean) ?? [];
  const base = llmConfigFromEnv({
    ...process.env,
    LLM_MODEL: process.env.LLM_MODEL?.trim() || configuredModels[0],
  });
  if (base === null) {
    process.stderr.write('Set LLM_API_URL, LLM_API_KEY, and LLM_MODEL or ANALYST_MODELS.\n');
    return 1;
  }
  const modelIds = configuredModels.length === 0 ? [base.model] : configuredModels;
  const runs = Number.parseInt(process.env.LLM_EVAL_RUNS ?? '3', 10);
  const models = modelIds.map((id) => {
    const config = { ...base, model: id };
    return {
      id,
      client: llmChatClient(config),
      countPromptTokens: (messages: Parameters<typeof countLlmTokens>[1]) => countLlmTokens(config, messages),
    };
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
