// The live eval — the ONLY thing in this repo that calls a real model.
//
//   npm run eval:llm
//
// Deliberately not a vitest test. Automated tests use recorded responses because
// a suite that hits an API is slow,
// costs money, fails when the network does, and — the one that actually matters —
// stops being runnable on a clean clone with no credentials.
//
// A regression floor can be set only after reviewing this measurement. Record the
// model, prompt, corpus, run count, date, and failures together.
//
// Honest limits, so the number is not over-read:
//   - eight corpus rows. Enough to see a difference, nowhere near enough to
//     size one. Treat a 1-row delta as noise.
//   - the corpus is synthetic, so it
//     measures the parser against phrasings WE wrote.
//   - one model, one prompt, one temperature-0 run. It is a reading, not a study.

import { EVAL_ROWS } from '../tests/corpus';
import { formatScore, gradeRow, groupConsistency, groupingKey, repeatableRuns, score } from '../tests/grade';
import { llmConfigFromEnv, llmChatClient } from '../src/parser/chatClient';
import { createLlmParser } from '../src/parser/llmParser';
import { parseReport } from '../src/parser/reportParser';

async function main(): Promise<number> {
  const config = llmConfigFromEnv();
  if (config === null) {
    process.stderr.write(
      '\n  No LLM provider credentials configured — nothing to measure.\n' +
        '  Set LLM_API_URL, LLM_API_KEY and LLM_MODEL (see .env.example).\n\n' +
        '  This is not a failure. The service uses its keyword fallback when the key is absent.\n\n',
    );
    return 0;
  }

  const repeats = Number.parseInt(process.env.LLM_EVAL_RUNS ?? '5', 10);
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error('LLM_EVAL_RUNS must be a positive integer');
  process.stdout.write(`\n  model: ${config.model}   rows: ${EVAL_ROWS.length}   runs: ${repeats}\n`);

  // The wall clock, on purpose: the future-observedAt guard should be measured
  // against real time when the model is real. Everywhere else in the project the
  // clock is injected and fixed; this script is the one place a real run is the
  // point.
  const parser = createLlmParser({ client: llmChatClient(config), now: () => new Date() });

  const keywordResults = EVAL_ROWS.map((row) => {
    const report = parseReport(row.input);
    return { row, report, fields: gradeRow(row, report) };
  });

  type LlmResult = { row: (typeof EVAL_ROWS)[number]; report: Awaited<ReturnType<typeof parser.parse>>['report']; fields: ReturnType<typeof gradeRow> };
  const llmResults: LlmResult[] = [];
  const runs: LlmResult[][] = [];
  let fellBack = 0;
  let repaired = 0;
  for (let run = 0; run < repeats; run++) {
    const current: LlmResult[] = [];
    for (const row of EVAL_ROWS) {
      const { report, source, repairAttempted } = await parser.parse(row.input);
      if (source === 'keyword') fellBack++;
      if (repairAttempted === true) repaired++;
      current.push({ row, report, fields: gradeRow(row, report) });
    }
    runs.push(current);
    if (run === 0) llmResults.push(...current);
  }

  process.stdout.write(formatScore('Stage-1 keyword parser (baseline)', keywordResults));
  process.stdout.write(formatScore(`Stage-2 LLM parser — ${config.model} (MEASURED)`, llmResults));

  const keyword = score(keywordResults);
  const llm = score(llmResults);
  const repeatable = repeatableRuns(runs);
  const groups = groupConsistency(llmResults);
  const attempts = repeats * EVAL_ROWS.length;
  const unsafe = llmResults.filter(({ row, report }) => {
    const expectedService = typeof row.service === 'string' ? row.service : 'unknown';
    return report.scope !== row.scope || report.building !== row.building || report.room !== row.room ||
      groupingKey(report) !== groupingKey({ service: expectedService, scope: row.scope, building: row.building, room: row.room });
  });

  process.stdout.write(
    [
      `  delta          : ${llm.correct - keyword.correct} fields, ` +
        `${llm.exactRows - keyword.exactRows} exact rows`,
      `  fell back      : ${fellBack}/${attempts}   (LLM unusable, keyword answered)`,
      `  repaired       : ${repaired}/${attempts}   (one retry, never two)`,
      `  group consistency: ${groups.consistentRows}/${groups.rows} rows (${groups.consistentGroups}/${groups.groups} groups)`,
      `  repeatability  : ${repeatable ? 'stable' : 'UNSTABLE'} across ${repeats} runs`,
      `  unsafe errors  : ${unsafe.length} (scope/building/room/grouping)`,
      '',
      fellBack === EVAL_ROWS.length
        ? '  Every row fell back. The API may be unreachable or its responses may be unusable.\n' +
          '  No model result was measured; inspect connectivity and parser diagnostics.'
        : `  Measured ${llm.correct}/${llm.total} fields with ${config.model}. Record the model,\n` +
          '  date, prompt/corpus version, runs, repairs, and fallbacks before setting a\n' +
          '  regression floor. See README.md for model-evaluation guidance.',
      '',
      '',
    ].join('\n'),
  );

  return llm.correct === llm.total && llm.exactRows === llm.rows && groups.ok && repeatable &&
    fellBack === 0 && repaired === 0 && unsafe.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    // Status only, never the provider body; it can echo request headers.
    process.stderr.write(`\n  eval failed: ${error instanceof Error ? error.message : 'unknown'}\n\n`);
    process.exit(1);
  },
);
