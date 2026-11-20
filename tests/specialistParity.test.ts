// The specialist models: TypeScript must compute exactly what Python certified.
//
// models/parity-fixtures.json was written by training/train.py from the ROUNDED
// exported weights. If tokenizing, masking, hashing or the dot product drift
// between the two languages, these tests fail instead of a threshold quietly
// meaning something else in production.

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { featureBuckets, maskPlaces } from '../src/parser/features';
import { headProbabilities, loadSpecialist, validateWeights, WEIGHTS_PATH } from '../src/parser/specialist';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const weights = JSON.parse(readFileSync(WEIGHTS_PATH, 'utf8'));
const fixtures = JSON.parse(read('../models/parity-fixtures.json')) as {
  text: string;
  buckets: number[];
  probabilities: Record<string, number[]>;
  labels: Record<string, string>;
  confident: boolean;
  frustrationConfident: boolean;
}[];
const specialist = loadSpecialist();

describe('Python and TypeScript agree (models/parity-fixtures.json)', () => {
  it('covers the risky inputs: empty, one word, non-ASCII, emoji, very long', () => {
    const texts = fixtures.map((f) => f.text);
    expect(texts).toContain('');
    expect(texts).toContain('wifi');
    expect(texts.some((t) => [...t].some((c) => c.charCodeAt(0) > 127))).toBe(true);
    expect(texts.some((t) => t.length >= 2000)).toBe(true);
  });

  it('masks and hashes every fixture to the same buckets', () => {
    for (const f of fixtures) expect(featureBuckets(maskPlaces(f.text)), f.text.slice(0, 40)).toEqual(f.buckets);
  });

  it('computes the same probabilities, to 1e-9, for every head', () => {
    for (const f of fixtures) {
      for (const [head, expected] of Object.entries(f.probabilities)) {
        const got = headProbabilities(weights, head as 'service', f.buckets);
        got.forEach((p, i) => expect(Math.abs(p - expected[i])).toBeLessThan(1e-9));
      }
    }
  });

  it('makes the same accept / abstain decision as the training script', () => {
    for (const f of fixtures) {
      const guess = specialist.predict(f.text);
      expect(guess.confident, f.text.slice(0, 40)).toBe(f.confident);
      expect(guess.frustrated !== undefined, f.text.slice(0, 40)).toBe(f.frustrationConfident);
      expect({ service: guess.service, scope: guess.scope, symptom: guess.symptom }).toEqual({
        service: f.labels.service, scope: f.labels.scope, symptom: f.labels.symptom,
      });
    }
  });
});

describe('the committed weights file', () => {
  it('matches this code: feature configuration, catalog labels, finite numbers, thresholds in range', () => {
    expect(() => validateWeights(weights)).not.toThrow();
  });

  it('was trained on the committed training set (stale weights are caught offline)', () => {
    const dataset = readFileSync(fileURLToPath(new URL('../data/train/dataset.jsonl', import.meta.url)));
    expect(weights.header.datasetSha256).toBe(createHash('sha256').update(dataset).digest('hex'));
  });

  it('stays under the 1.5 MB budget (council M2 follow-up ruling 2)', () => {
    expect(statSync(WEIGHTS_PATH).size).toBeLessThan(1.5 * 1024 * 1024);
  });

  it('rejects a file that does not match this code', () => {
    const copy = (): typeof weights => JSON.parse(JSON.stringify(weights));
    const relabelled = copy();
    relabelled.heads.service.labels = [...relabelled.heads.service.labels].reverse();
    const resized = copy();
    resized.header.dimensions = 1024;
    const lowTau = copy();
    lowTau.header.tau = 0.1;
    const broken = copy();
    const firstBucket = Object.keys(broken.rows)[0];
    broken.rows[firstBucket].scope[0] = null;
    expect(() => validateWeights(relabelled)).toThrow(/labels differ from the catalog/);
    expect(() => validateWeights(resized)).toThrow(/feature configuration/);
    expect(() => validateWeights(lowTau)).toThrow(/out of range/);
    expect(() => validateWeights(broken)).toThrow(/malformed/);
  });
});
