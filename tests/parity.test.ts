// Parser parity and stage parity — the two S=2 rows in tests/test_matrix.md.
// One measures whether stage 2 was worth doing; the other, whether it changed
// anything it should not have.
//
// **DIFFERENCES ARE RECORDED, NOT ASSERTED AWAY** (test_matrix.md S=2). No
// threshold is pinned here and none may be added until `npm run eval:llm` has
// produced a real number against a real model. A floor
// invented in this file before that measurement is theatre — it encodes a guess
// as a gate, and a gate gets defended as evidence.
//
// The LLM side runs on recorded responses, so this file measures the PLUMBING —
// does the LLM path reach the same decisions the deterministic core reached —
// and not model quality. Model quality is `npm run eval:llm`, the one thing in
// this repo that touches the API.

import { beforeEach, describe, expect, it } from 'vitest';

import { configureGate, resetGate } from '../src/clusterGate';
import type { ProblemReport } from '../src/contracts/types';
import { handleReport, type Parser } from '../src/orchestrator';
import { createLlmParser } from '../src/parser/llmParser';
import { parseReport } from '../src/parser/reportParser';
import { configureThrottle, resetThrottle } from '../src/throttleLimits';
import { CORPUS_NOW, EVAL_ROWS, FLOWS, type FlowScenario } from './corpus';
import { formatScore, gradeRow, score } from './grade';
import { harness, IDENTITY_REF, TEST_GATE, TEST_THROTTLE } from './harness';
import { fakeClient } from './llmFixtures';
import { canonicalBuilding } from '../src/vocab/locations';

const NOW = new Date(CORPUS_NOW);
const now = (): Date => NOW;

/**
 * A client that answers with the row's own labelled fields — a stand-in for a
 * model that gets everything right.
 *
 * NOT a claim that a model would. It isolates the only question this file can
 * answer offline: when the LLM path produces a correct record, does everything
 * downstream behave identically? A recorded fixture cannot measure a model, and
 * a suite that pretends otherwise starts reporting an accuracy number nobody
 * measured.
 */
function oracleParser(fields: {
  service: string;
  scope: string;
  location: string;
  building?: string;
  room?: string;
  symptom: string;
  observedAt?: string;
}): Parser {
  const response = JSON.stringify({
    service: fields.service,
    scope: fields.scope,
    location: fields.location,
    building: fields.location === '' ? '' : fields.building ?? canonicalBuilding(fields.location),
    room: fields.room ?? '',
    symptom: fields.symptom,
    observedAt: fields.observedAt ?? '',
  });
  // Two identical responses: if repair runs on a record that already conforms,
  // the second call answers it rather than throwing, so
  // this suite reports a parity difference instead of a confusing client error.
  return createLlmParser({ client: fakeClient(response, response), now });
}

// ── Parser parity (test_matrix.md S=2) ────────────────────────────────────────

describe('parser parity over the corpus', () => {
  it('records both parsers against the same rows, asserting no floor', async () => {
    const keywordResults = EVAL_ROWS.map((row) => ({
      row,
      report: parseReport(row.input),
      fields: gradeRow(row, parseReport(row.input)),
    }));

    const llmResults = [];
    let ranOnLlm = 0;
    for (const row of EVAL_ROWS) {
      const parser = oracleParser({
        service: Array.isArray(row.service) ? 'unknown' : row.service as string,
        scope: row.scope,
        location: row.location,
        room: row.room,
        symptom: row.symptom,
      });
      const { report, source } = await parser.parse(row.input);
      if (source === 'llm') ranOnLlm++;
      llmResults.push({ row, report, fields: gradeRow(row, report) });
    }

    process.stdout.write(formatScore('Stage-1 keyword parser (baseline)', keywordResults));
    process.stdout.write(
      formatScore('Stage-2 path, RECORDED responses — plumbing, not a model score', llmResults),
    );

    const keyword = score(keywordResults);
    const withLlm = score(llmResults);
    process.stdout.write(
      ranOnLlm === 0
        ? '  LLM path did not run on any row — every parse fell back to keywords.\n' +
            '  Check the parser and recorded responses before treating this as an LLM result.\n\n'
        : `  rows parsed by the LLM path: ${ranOnLlm}/${EVAL_ROWS.length}\n` +
            `  delta (recorded, NOT a model score): ${withLlm.correct - keyword.correct} fields, ` +
            `${withLlm.exactRows - keyword.exactRows} exact rows\n` +
            '  Run `npm run eval:llm` for a live model measurement.\n\n',
    );

    // The only assertions: both parsers ran every row, and neither threw.
    // No comparison, no floor — see the file header.
    expect(keywordResults).toHaveLength(EVAL_ROWS.length);
    expect(llmResults).toHaveLength(EVAL_ROWS.length);
  });

  it('scores a perfect oracle at 100 percent over six fields per row', () => {
    const perfectResults = EVAL_ROWS.map((row) => {
      const service = typeof row.service === 'string' ? row.service : 'unknown';
      const report: ProblemReport = {
        service,
        scope: row.scope,
        location: row.location,
        building: row.building,
        room: row.room,
        symptom: row.symptom,
        observedAt: '',
        verbatim: row.input,
      };
      return { row, report, fields: gradeRow(row, report) };
    });

    const result = score(perfectResults);
    expect(result.correct).toBe(156);
    expect(result.total).toBe(156);
    expect(result.correct).toBe(result.total);
    expect((result.correct / result.total) * 100).toBe(100);
    expect(result.groupConsistency.ok).toBe(true);
  });
});

// ── Stage parity (test_matrix.md S=2) ─────────────────────────────────────────

/**
 * One flow, one parser, one outcome. Everything except the parser — the world,
 * the clock, the adapters, the injected constants — is held identical, which is
 * what makes a difference in the result attributable to the swap and nothing
 * else.
 */
async function outcomeOf(s: FlowScenario, parser: Parser): Promise<string> {
  const h = harness(s.report);
  const deps = { ...h.deps, parser };

  h.incidents.seed(s.world.candidates);
  if (s.world.searchFails === true) h.incidents.failTimes = Number.POSITIVE_INFINITY;
  if (s.world.throttled === true) {
    const { hash } = await deps.identity.resolve(IDENTITY_REF);
    for (let i = 0; i < TEST_THROTTLE.maxReportsPerIdentity; i++) {
      await h.limiter.record(hash, s.report);
    }
  }

  const res = await handleReport(
    {
      text: s.report.verbatim,
      identityRef: IDENTITY_REF,
      canFollowUp: s.world.canFollowUp,
      overrideMatchId: s.world.overrideMatchId,
    },
    deps,
  );
  return res.outcome;
}

/** Stage-1 fixture parser, matching the flow-test setup. */
function fixtureParser(report: ProblemReport): Parser {
  return { parse: async () => ({ report, source: 'keyword' }) };
}

describe('stage parity: same flows, same outcomes under a swapped parser', () => {
  // test_matrix.md S=2: "every flow above produces the same outcome under stage-1
  // and stage-2 wiring (ticket numbers differ; decisions do not)."
  //
  // If an outcome moves when ONLY the parser changed, the parser is reaching a
  // decision — the exact thing contracts/decision.md's four-branch purity and
  // ProblemReport's six-field shape exist to make impossible. That would be a
  // finding worth stopping the build for, not a test to adjust.
  //
  beforeEach(() => {
    resetGate();
    resetThrottle();
    configureGate(TEST_GATE);
    configureThrottle(TEST_THROTTLE);
  });

  for (const s of FLOWS) {
    it(`${s.id} — outcome is identical whichever parser produced the record`, async () => {
      const stage1 = await outcomeOf(s, fixtureParser(s.report));
      const stage2 = await outcomeOf(s, oracleParser(s.report));

      expect(stage2).toBe(stage1);
      expect(stage1).toBe(s.expected);
    });
  }
});
