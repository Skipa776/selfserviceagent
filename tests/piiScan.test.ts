// safety/boundaries.md + report_corpus.md: the corpus is synthetic. No real
// report, name, PID, email, phone, or SSN is ever pasted in — at any stage. This
// test mechanically enforces the machine-detectable half of that rule over every
// free-text field in the registry. (A human still owns "is this a real person's
// name", which no regex catches — but nothing detectable slips through.)

import { describe, it, expect } from 'vitest';
import { EVAL_ROWS, FLOWS } from './corpus';

// Patterns for identifiers that must never appear in synthetic fixtures.
const PII_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: 'email', re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/ },
  { name: 'phone', re: /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/ },
  { name: 'US SSN', re: /\b\d{3}-\d{2}-\d{4}\b/ },
  { name: 'campus ID', re: /\bA\d{8}\b/ },
  { name: 'long digit run (9+)', re: /\d{9,}/ },
];

/** Every human-language string in the registry — the only place PII could hide. */
function freeText(): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  EVAL_ROWS.forEach((r, i) => {
    out.push({ where: `EVAL_ROWS[${i}].input`, text: r.input });
    if (r.note) out.push({ where: `EVAL_ROWS[${i}].note`, text: r.note });
  });
  for (const f of FLOWS) {
    out.push({ where: `${f.id}.report.verbatim`, text: f.report.verbatim });
    out.push({ where: `${f.id}.report.location`, text: f.report.location });
    out.push({ where: `${f.id}.note`, text: f.note });
    for (const c of f.world.candidates) {
      if (c.kind === 'declared_incident') {
        out.push({ where: `${f.id} ${c.id}.summary`, text: c.summary });
      }
    }
  }
  return out;
}

describe('corpus is synthetic (no PII)', () => {
  it('has the expected registry size', () => {
    // A guard against an empty/half-written registry silently passing the scan.
    expect(EVAL_ROWS.length).toBeGreaterThanOrEqual(20);
    // 13 base flows (F1–F13) + 2 per-topic-threshold flows (F14 deflects with
    // 10 existing Canvas peers; F15 files with 9 existing, creating the 10th).
    // Plus 2 classroom-projector boundary flows (F16 files, F17 deflects).
    expect(FLOWS.length).toBe(17);
  });

  for (const { name, re } of PII_PATTERNS) {
    it(`contains no ${name}`, () => {
      const hits = freeText()
        .filter(({ text }) => re.test(text))
        .map(({ where }) => where);
      expect(hits).toEqual([]);
    });
  }
});
