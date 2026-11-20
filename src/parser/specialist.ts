// The CDMForge specialists (Milestone 2): four small linear models trained by
// training/train.py and stored in models/weights.json — service, scope, symptom,
// and frustration. Prediction is a dot product over hashed word n-grams, a
// temperature, and a softmax. No network, no randomness, a few microseconds.
//
// A specialist only ever proposes catalog labels. Whether its proposal is used
// is decided by the router (router.ts) and the shared field rules; whether a
// ticket is created is decided, as always, by decide().

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SCOPES, SERVICES, SYMPTOMS } from '../vocab/catalog';
import { DIMENSIONS, MAX_TOKENS, featureBuckets, modelText } from './features';

export const WEIGHTS_PATH = fileURLToPath(new URL('../../models/weights.json', import.meta.url));

/** The lowest threshold the loader accepts: a lucky validation set cannot export a near-zero one. */
const TAU_FLOOR = 0.5;

const HEAD_LABELS = {
  service: [...SERVICES],
  scope: [...SCOPES],
  symptom: [...SYMPTOMS],
  frustrated: ['false', 'true'],
} as const;
type HeadName = keyof typeof HEAD_LABELS;
const REPORT_HEADS = ['service', 'scope', 'symptom'] as const;

type Head = { readonly labels: readonly string[]; readonly bias: readonly number[]; readonly temperature: number };
type Weights = {
  readonly header: { readonly tau: number | null; readonly frustrationTau: number | null; readonly datasetSha256: string } & Record<string, unknown>;
  readonly heads: Record<HeadName, Head>;
  readonly rows: Record<string, Record<HeadName, readonly number[]>>;
};

/** What the audit log records about a specialist answer (council M2-Q10). */
export type SpecialistAudit = {
  readonly confidence: { readonly service: number; readonly scope: number; readonly symptom: number };
  readonly tau: number | null;
  readonly datasetSha256: string;
};

export type SpecialistGuess = {
  readonly service: string;
  readonly scope: string;
  readonly symptom: string;
  /** Every report head at or above tau and none says 'unknown'. The router still applies the field rules. */
  readonly confident: boolean;
  /** Present only when the frustration head is at or above its own threshold. */
  readonly frustrated?: boolean;
  readonly audit: SpecialistAudit;
};

export type Specialist = { predict(text: string): SpecialistGuess };

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const sameList = (a: readonly unknown[], b: readonly unknown[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Checks a weights file against this code before anything uses it: same
 * feature configuration, same label lists as the catalog, finite numbers, and
 * thresholds in range. A stale or damaged file throws with the reason.
 */
export function validateWeights(raw: unknown): Weights {
  const fail = (why: string): never => {
    throw new Error(`specialist weights: ${why}`);
  };
  const w = raw as Weights;
  const h = w?.header ?? fail('no header');
  if (h.format !== 'cdmforge-linear-v1' || h.hash !== 'fnv1a-32') fail('unknown format or hash');
  if (h.dimensions !== DIMENSIONS || h.maxTokens !== MAX_TOKENS) fail('feature configuration differs from features.ts');
  if (!Array.isArray(h.ngrams) || !sameList(h.ngrams, [1, 2])) fail('n-gram configuration differs from features.ts');
  for (const tau of [h.tau, h.frustrationTau]) {
    if (tau !== null && !(finite(tau) && tau >= TAU_FLOOR && tau <= 1)) fail(`threshold ${String(tau)} out of range`);
  }
  if (typeof h.datasetSha256 !== 'string') fail('no dataset hash');
  for (const name of Object.keys(HEAD_LABELS) as HeadName[]) {
    const head = w.heads?.[name] ?? fail(`missing head ${name}`);
    if (!sameList(head.labels, HEAD_LABELS[name])) fail(`${name} labels differ from the catalog`);
    if (head.bias.length !== head.labels.length || !head.bias.every(finite)) fail(`${name} bias is malformed`);
    if (!finite(head.temperature) || head.temperature <= 0) fail(`${name} temperature is malformed`);
  }
  for (const [bucket, row] of Object.entries(w.rows ?? fail('no rows'))) {
    const index = Number(bucket);
    if (!Number.isInteger(index) || index < 0 || index >= DIMENSIONS) fail(`bucket ${bucket} out of range`);
    for (const name of Object.keys(HEAD_LABELS) as HeadName[]) {
      if (row[name]?.length !== HEAD_LABELS[name].length || !row[name].every(finite)) fail(`bucket ${bucket} ${name} is malformed`);
    }
  }
  return w;
}

function softmax(logits: number[]): number[] {
  const max = Math.max(...logits);
  const e = logits.map((z) => Math.exp(z - max));
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / sum);
}

/** Class probabilities for one head: bias plus one weight row per known bucket, then temperature and softmax. */
export function headProbabilities(weights: Weights, head: HeadName, buckets: readonly number[]): number[] {
  const { bias, temperature } = weights.heads[head];
  const logits = [...bias];
  for (const b of buckets) {
    const row = weights.rows[b]?.[head];
    if (row !== undefined) row.forEach((w, i) => (logits[i] += w));
  }
  return softmax(logits.map((z) => z / temperature));
}

export function loadSpecialist(path = WEIGHTS_PATH): Specialist {
  const weights = validateWeights(JSON.parse(readFileSync(path, 'utf8')));
  const { tau, frustrationTau, datasetSha256 } = weights.header;
  return {
    predict(text) {
      const buckets = featureBuckets(modelText(text));
      const best = (head: HeadName): { label: string; p: number } => {
        const probs = headProbabilities(weights, head, buckets);
        const i = probs.indexOf(Math.max(...probs));
        return { label: weights.heads[head].labels[i], p: probs[i] };
      };
      const [service, scope, symptom] = REPORT_HEADS.map(best);
      const frustration = best('frustrated');
      const minConfidence = Math.min(service.p, scope.p, symptom.p);
      return {
        service: service.label,
        scope: scope.label,
        symptom: symptom.label,
        // A confident 'unknown' would skip the LLM on exactly the hard reports (council M2-Q11).
        confident: tau !== null && minConfidence >= tau && [service, scope, symptom].every((g) => g.label !== 'unknown'),
        ...(frustrationTau !== null && frustration.p >= frustrationTau ? { frustrated: frustration.label === 'true' } : {}),
        audit: { confidence: { service: service.p, scope: scope.p, symptom: symptom.p }, tau, datasetSha256 },
      };
    },
  };
}
