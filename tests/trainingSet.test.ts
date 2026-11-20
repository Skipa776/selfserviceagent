// The training-set builder (scripts/buildTrainingSet.ts): the guards that keep
// the specialist's evaluation honest, and the committed data matching the code.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildTrainingSet } from '../scripts/buildTrainingSet';
import { EVAL_ROWS } from './corpus';

const { rows } = buildTrainingSet();

describe('the training set', () => {
  it('is exactly what the builder produces (the committed file is not stale)', () => {
    const committed = readFileSync(fileURLToPath(new URL('../data/train/dataset.jsonl', import.meta.url)), 'utf8');
    expect(committed).toBe(rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  });

  it('never lets one template family or Haiku batch span two splits', () => {
    const splitOf = new Map<string, string>();
    for (const r of rows) {
      expect(splitOf.get(r.group) ?? r.split, r.group).toBe(r.split);
      splitOf.set(r.group, r.split);
    }
  });

  it('contains no development-set text', () => {
    const dev = new Set(EVAL_ROWS.map((r) => r.input.toLowerCase().replace(/\s+/g, ' ').trim()));
    for (const r of rows) expect(dev.has(r.text.toLowerCase().replace(/\s+/g, ' ').trim())).toBe(false);
  });

  it('labels a location scope exactly when the service itself would find a place', () => {
    for (const r of rows) expect(r.scope === 'location').toBe(r.location !== '');
  });

  it('shows Python no building name: every recognized place is masked', () => {
    const named = rows.filter((r) => r.location !== '');
    expect(named.length).toBeGreaterThan(0);
    for (const r of named) expect(r.featureText).toContain('xplacex');
  });
});
