// `npm run eval:router [-- data/handwritten/reports.jsonl]` — the end-to-end
// parser comparison on the same rows (council M2-Q8, Q13):
//
//   keyword only · specialist alone (what it accepts) · router (specialist, then
//   keyword) · and, with ANTHROPIC_API_KEY, Haiku only and router (specialist,
//   then Haiku), each Haiku arm run 3 times (Haiku 5.5 is not repeatable).
//
// Default rows: the 26-row DEVELOPMENT set (tests/corpus.ts). The keyword parser
// and the M1 prompt were tuned on it, so it supports counts, not rates: this
// prints counts. Never tune anything on these numbers.

import { createRouter } from '../src/parser/router';
import { createLlmParser, createMessageFromEnv } from '../src/parser/llmParser';
import { parseReport } from '../src/parser/reportParser';
import { loadSpecialist } from '../src/parser/specialist';
import { isFrustrated } from '../src/frustration';
import type { Parser } from '../src/orchestrator';
import { EVAL_ROWS, type EvalRow } from '../tests/corpus';
import { gradeRow } from '../tests/grade';
import { loadHandwrittenSet } from '../tests/handwrittenSet';

const HAIKU_RUNS = 3;
const keyword: Parser = { parse: async (text) => ({ report: parseReport(text), source: 'keyword' }) };

/** Fields correct (6 graded fields per row), rows fully correct, and how many rows each source answered. */
async function measure(parser: Parser, rows: readonly EvalRow[]): Promise<{ fields: number; exact: number; sources: Record<string, number> }> {
  let fields = 0;
  let exact = 0;
  const sources: Record<string, number> = {};
  for (const row of rows) {
    const result = await parser.parse(row.input);
    const graded = gradeRow(row, result.report);
    fields += graded.filter((f) => f.ok).length;
    if (graded.every((f) => f.ok)) exact++;
    sources[result.source] = (sources[result.source] ?? 0) + 1;
  }
  return { fields, exact, sources };
}

async function main(): Promise<number> {
  const setPath = process.argv[2];
  const rows = setPath === undefined ? EVAL_ROWS : loadHandwrittenSet(setPath);
  if (rows === null) {
    process.stderr.write(`${setPath} is still the placeholder (data/handwritten/README.md).\n`);
    return 0;
  }
  const specialist = loadSpecialist();
  const total = rows.length * 6;
  const line = (label: string, m: { fields: number; exact: number; sources: Record<string, number> }): void => {
    process.stdout.write(`  ${label.padEnd(34)} fields ${m.fields}/${total}   exact rows ${m.exact}/${rows.length}   answered by ${JSON.stringify(m.sources)}\n`);
  };

  process.stdout.write(`\n  rows: ${rows.length} (${setPath ?? 'tests/corpus.ts — DEVELOPMENT set, counts only'})\n\n`);
  line('keyword only', await measure(keyword, rows));

  // The specialist on its own: how many it accepts, and how many of those are wrong.
  let accepted = 0;
  let wrong = 0;
  const router = createRouter(specialist, keyword);
  for (const row of rows) {
    const result = await router.parse(row.input);
    if (result.source !== 'specialist') continue;
    accepted++;
    const graded = gradeRow(row, result.report).filter((f) => ['service', 'scope', 'symptom'].includes(f.field));
    if (!graded.every((f) => f.ok)) wrong++;
  }
  process.stdout.write(`  specialist accepts ${accepted}/${rows.length}; ${wrong} of those have service, scope or symptom wrong\n`);
  line('router: specialist -> keyword', await measure(router, rows));

  // Frustration: these rows carry no frustration labels, so only agreement with today's lexical rule.
  let confident = 0;
  let agree = 0;
  for (const row of rows) {
    const guess = specialist.predict(row.input);
    if (guess.frustrated === undefined) continue;
    confident++;
    if (guess.frustrated === isFrustrated(row.input)) agree++;
  }
  process.stdout.write(`  frustration head confident on ${confident}/${rows.length}; agrees with the lexical rule on ${agree}/${confident}\n`);

  const createMessage = createMessageFromEnv();
  if (createMessage === null) {
    process.stdout.write('\n  No ANTHROPIC_API_KEY: Haiku arms not measured.\n\n');
    return 0;
  }
  for (const [label, makeParser] of [
    ['haiku only', () => createLlmParser({ createMessage, now: () => new Date() })],
    ['router: specialist -> haiku', () => createRouter(specialist, createLlmParser({ createMessage, now: () => new Date() }))],
  ] as const) {
    const runs = [];
    for (let run = 0; run < HAIKU_RUNS; run++) runs.push(await measure(makeParser(), rows));
    const f = runs.map((r) => r.fields);
    const mean = f.reduce((a, b) => a + b, 0) / f.length;
    process.stdout.write(`  ${label.padEnd(34)} fields mean ${mean.toFixed(1)}/${total} (range ${Math.min(...f)}–${Math.max(...f)}) over ${HAIKU_RUNS} runs; exact rows ${runs.map((r) => r.exact).join(', ')}; answered by ${JSON.stringify(runs[0].sources)}\n`);
  }
  process.stdout.write('\n');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`eval failed: ${error instanceof Error ? error.message : 'unknown'}\n`);
    process.exit(1);
  },
);
