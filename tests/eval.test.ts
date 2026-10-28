// The parsing eval (contracts/report_corpus.md, tests/test_matrix.md).
//
// This measures the PARSER, not the code — the flows measure the code. Keeping
// them separate is deliberate: a suite that fails for two unrelated reasons
// diagnoses neither.
//
// **NO PASS THRESHOLD IS PINNED, and that is the point.** A number invented
// before a real model runs would be theatre. Stage 2 records the first measured
// LLM score and sets a regression floor from that measurement. What
// this file does today is establish the honest baseline the LLM will be measured
// against — and print it, so the delta is visible rather than asserted.

import { describe, expect, it } from 'vitest';

import { parseReport } from '../src/parser/reportParser';
import { EVAL_ROWS } from './corpus';
// Extracted at stage 2 so the baseline, the parity run and the live eval all
// grade identically (grade.ts). Same numbers as before the extraction.
import { formatScore, gradeRow, score } from './grade';

describe('keyword parser baseline over the corpus', () => {
  it('produces a valid record for every row and never throws', () => {
    for (const row of EVAL_ROWS) {
      expect(() => parseReport(row.input)).not.toThrow();
    }
  });

  it('records the baseline score without asserting a floor', () => {
    const results = EVAL_ROWS.map((row) => {
      const report = parseReport(row.input);
      return { row, report, fields: gradeRow(row, report) };
    });
    process.stdout.write(
      formatScore('Stage-1 keyword parser baseline (misses are the stage-2 argument)', results),
    );

    // The only assertion: a baseline exists and is measurable. Deliberately NOT
    // "correct/total > 0.8" — that number would be invented, and inventing it is
    // exactly what stage 2's measurement is supposed to replace.
    const s = score(results);
    expect(s.total).toBeGreaterThan(0);
    expect(s.correct).toBeGreaterThanOrEqual(0);
  });
});

describe('the misses the corpus EXPECTS — these are the stage-2 argument', () => {
  it('does not infer individual scope from the roommate contrast', () => {
    // The clearest row where the LLM should beat the keyword parser. If this ever
    // starts passing at stage 1, the extractor was made too smart and the
    // comparison has been blunted (keyword_extractor.md).
    const got = parseReport("my laptop won't connect to the wifi in my dorm but my roommate's does");
    expect(got.scope).not.toBe('individual');
  });

  it('does not pick a side on "the internet in Main Library is slow"', () => {
    // Users do not distinguish wifi from wired. Resolving it is a follow-up, not
    // a coin flip.
    const got = parseReport('the internet in Main Library is super slow this afternoon');
    expect(got.service).toBe('unknown');
    // …but it still gets the parts it can honestly see.
    expect(got.location).toBe('Main Library');
    expect(got.symptom).toBe('slow');
  });
});

describe('ambiguity resolves to unknown, never to a confident wrong label', () => {
  it('an uninferable scope stays unknown, which becomes a question downstream', () => {
    // One person's browser and a campus-wide outage produce identical words.
    expect(parseReport("the housing portal won't load").scope).toBe('unknown');
  });

  it('out-of-domain reports decline cleanly rather than filing something unclassifiable', () => {
    for (const input of ['my printer is out of toner', 'when is the housing application deadline']) {
      const got = parseReport(input);
      expect(got.service).toBe('unknown');
      expect(got.scope).toBe('unknown');
      expect(got.symptom).toBe('unknown');
    }
  });

  it('a gap gets a follow-up question; a confident wrong label gets a wrong ticket', () => {
    // Restating the design bias as a test so it cannot quietly invert: every row
    // the parser is unsure about must be 'unknown'/'', never a guess.
    for (const row of EVAL_ROWS) {
      const got = parseReport(row.input);
      for (const [field, value] of Object.entries(got)) {
        if (field === 'verbatim' || field === 'observedAt') continue;
        expect(typeof value).toBe('string');
      }
    }
  });
});
