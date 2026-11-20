// `npm run build:training-set` — builds data/train/dataset.jsonl, the one file
// training/train.py reads. Offline and deterministic (fixed seed).
//
//   1. Fills the sentence families in training/templates.json (SYNTHETIC).
//   2. Adds the Haiku-written rows from data/train/haiku.jsonl (SYNTHETIC).
//   3. Annotates every row with the DETERMINISTIC location extraction the service
//      itself uses (parseReport), so Python never needs its own building matcher.
//   4. Drops rows whose scope label contradicts that extraction, duplicates, and
//      anything equal to a development-set row (tests/corpus.ts).
//   5. Assigns grouped splits: templated rows by sentence family, Haiku rows by
//      generation batch, so near-duplicates never straddle train and validation.
//   6. Stores the capped, place-masked text Python trains on (features.ts modelText), and
//      what today's lexical frustration rule says, for the held-out comparison.
//
// It also writes data/train/parity-inputs.jsonl: the texts whose probabilities
// Python records for tests/specialistParity.test.ts, with their masked form.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { isFrustrated } from '../src/frustration';
import { modelText } from '../src/parser/features';
import { parseReport } from '../src/parser/reportParser';
import { AREA_TOKENS, BUILDINGS } from '../src/vocab/locations';
import { EVAL_ROWS } from '../tests/corpus';

const SEED = 20261120;
const ROWS_PER_FAMILY = 350;
const OFF_TOPIC_SHARE = 0.1;
const FRUSTRATED_SHARE = 0.4;
const OUTPUT = 'data/train/dataset.jsonl';

type Templates = {
  valid: Record<string, { scopes: string[]; symptoms: string[] }>;
  subjects: Record<string, string[]>;
  symptoms: Record<string, string[]>;
  scopes: Record<string, { lead: string[]; trail: string[] }>;
  tails: { frustrated: string[]; calm: string[] };
  families: string[];
  offTopic: string[];
};

export type TrainingRow = {
  id: string;
  text: string;
  service: string;
  scope: string;
  symptom: string;
  frustrated: boolean;
  location: string; // what the deterministic extractor found; '' if none
  featureText: string; // the text with places masked: the only text Python sees
  lexicalFrustrated: boolean; // what src/frustration.ts says, for comparison only
  group: string; // sentence family or Haiku batch: the unit of every split
  split: 'train' | 'validation' | 'heldout';
  origin: 'templated' | 'haiku';
};

/** mulberry32: a tiny seeded PRNG, so the templated rows are the same on every run. */
function seededRandom(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Collapses spaces, removes the space before punctuation, capitalizes the first letter. */
function tidy(text: string): string {
  const s = text.replace(/\s+/g, ' ').replace(/\s+([.,!?])/g, '$1').replace(/^[\s,]+/, '').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const normalized = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim();

type Unannotated = Omit<TrainingRow, 'location' | 'split' | 'featureText' | 'lexicalFrustrated'>;

function templatedRows(t: Templates): Unannotated[] {
  const random = seededRandom(SEED);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  // Every alias of every fictional building, plus the area tokens: places are
  // sampled independently of the labels, so a place name cannot predict a service.
  const places = [...BUILDINGS.flatMap((b) => [b.name, ...b.aliases]), ...AREA_TOKENS];
  const services = Object.keys(t.valid);
  const rows: Unannotated[] = [];

  t.families.forEach((family, f) => {
    for (let n = 0; n < ROWS_PER_FAMILY; n++) {
      const frustrated = random() < FRUSTRATED_SHARE;
      const tail = pick(frustrated ? t.tails.frustrated : t.tails.calm);
      const id = `t-${f}-${n}`;
      const group = `family-${f}`;
      if (random() < OFF_TOPIC_SHARE) {
        rows.push({ id, text: tidy(`${pick(t.offTopic)}${tail}`), service: 'unknown', scope: 'unknown', symptom: 'unknown', frustrated, group, origin: 'templated' });
        continue;
      }
      const service = pick(services);
      const scope = pick(t.valid[service].scopes);
      const symptom = pick(t.valid[service].symptoms);
      const roomChance = service === 'classroom_av' ? 0.5 : 0.15;
      const place = random() < roomChance ? `${pick(places)} room ${100 + Math.floor(random() * 400)}` : pick(places);
      const text = family
        .replace('{subject}', pick(t.subjects[service]))
        .replace('{symptom}', pick(t.symptoms[symptom]))
        .replace('{lead}', pick(t.scopes[scope].lead).replace('{place}', place))
        .replace('{trail}', pick(t.scopes[scope].trail).replace('{place}', place))
        .replace('{tail}', tail);
      rows.push({ id, text: tidy(text), service, scope, symptom, frustrated, group, origin: 'templated' });
    }
  });
  return rows;
}

function haikuRows(): Unannotated[] {
  const lines = readFileSync('data/train/haiku.jsonl', 'utf8').split('\n').filter((l) => l.trim() !== '');
  return lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => !('_meta' in row))
    .map((row, i) => ({
      id: `h-${i}`,
      text: String(row.text),
      service: String(row.service),
      scope: String(row.scope),
      symptom: String(row.symptom),
      frustrated: row.frustrated === true,
      group: String(row.batch),
      origin: 'haiku' as const,
    }));
}

function splitFor(row: Unannotated, familyCount: number): TrainingRow['split'] {
  if (row.origin === 'templated') {
    const family = Number(row.group.split('-')[1]);
    // Last family held out; the two before it validate; the rest train.
    return family === familyCount - 1 ? 'heldout' : family >= familyCount - 3 ? 'validation' : 'train';
  }
  // Haiku batches: 60 / 20 / 20 by a hash of the batch id (stable, label-blind).
  const bucket = createHash('sha256').update(row.group).digest()[0] % 10;
  return bucket < 6 ? 'train' : bucket < 8 ? 'validation' : 'heldout';
}

export function buildTrainingSet(): { rows: TrainingRow[]; dropped: Record<string, number> } {
  const t = JSON.parse(readFileSync('training/templates.json', 'utf8')) as Templates;
  const devSet = new Set(EVAL_ROWS.map((r) => normalized(r.input)));
  const seen = new Set<string>();
  const dropped = { scopeContradictsPlace: 0, duplicate: 0, developmentSetText: 0 };
  const rows: TrainingRow[] = [];

  for (const row of [...templatedRows(t), ...haikuRows()]) {
    const key = normalized(row.text);
    if (devSet.has(key)) { dropped.developmentSetText++; continue; }
    if (seen.has(key)) { dropped.duplicate++; continue; }
    const location = parseReport(row.text).location;
    // The service's own rule: a location scope needs a recognized place, and no
    // other scope may carry one. A row that breaks it would teach a label the
    // router can never accept.
    if ((row.scope === 'location') !== (location !== '')) { dropped.scopeContradictsPlace++; continue; }
    seen.add(key);
    rows.push({
      ...row,
      location,
      featureText: modelText(row.text),
      lexicalFrustrated: isFrustrated(row.text),
      split: splitFor(row, t.families.length),
    });
  }
  return { rows, dropped };
}

/** Fails loudly when validation is too small to choose a threshold on (council M2-Q7). */
function checkValidationSize(rows: readonly TrainingRow[]): void {
  const validation = rows.filter((r) => r.split === 'validation');
  if (validation.length < 500) throw new Error(`validation has ${validation.length} rows; need at least 500`);
  for (const field of ['service', 'scope', 'symptom', 'frustrated'] as const) {
    const counts = new Map<string, number>();
    for (const r of validation) counts.set(String(r[field]), (counts.get(String(r[field])) ?? 0) + 1);
    for (const [value, n] of counts) {
      if (n < 30) throw new Error(`validation has ${n} rows with ${field}=${value}; need at least 30`);
    }
  }
}

/** Edge cases for the Python/TypeScript parity test, plus a spread of held-out rows. */
const PARITY_TEXTS = [
  '',
  'wifi',
  'the wifi in North Residence Hall keeps dropping',
  'Le wifi ne marche pas à la bibliothèque — très lent 😡',
  "THE PROJECTOR WON'T TURN ON!!! ÉCOLE Ⅻ ﬁx",
  'everyone everywhere campus-wide outage nobody can connect my laptop only',
  'frustrated again again again AGAIN ridiculous fed up still broken!!',
  'printer '.repeat(450),
  'the vpn keeps asking me to sign in over and over '.repeat(60).slice(0, 2000),
];

if (process.argv[1]?.endsWith('buildTrainingSet.ts')) {
  const { rows, dropped } = buildTrainingSet();
  checkValidationSize(rows);
  writeFileSync(OUTPUT, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const heldout = rows.filter((r) => r.split === 'heldout');
  const parityTexts = [...PARITY_TEXTS, ...heldout.filter((_, i) => i % Math.max(1, Math.floor(heldout.length / 20)) === 0).slice(0, 20).map((r) => r.text)];
  writeFileSync('data/train/parity-inputs.jsonl', parityTexts.map((text) => JSON.stringify({ text, featureText: modelText(text) })).join('\n') + '\n');
  const count = (split: string, origin: string): number => rows.filter((r) => r.split === split && r.origin === origin).length;
  for (const split of ['train', 'validation', 'heldout']) {
    process.stdout.write(`${split.padEnd(10)} templated ${count(split, 'templated')}  haiku ${count(split, 'haiku')}\n`);
  }
  process.stdout.write(`dropped: ${JSON.stringify(dropped)}\nwrote ${rows.length} rows to ${OUTPUT}\n`);
}
