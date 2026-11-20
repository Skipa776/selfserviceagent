// `npm run eval:alerts -- <alerts.jsonl>` — measures the security-alert grouping
// against the producer's ground truth (council M3-Q8). Offline; takes a path,
// fetches nothing. ground_truth is read HERE ONLY, after grouping, joined by
// position; the adapter never sees it.
//
// Prints aggregates only (no hostnames, titles or per-alert rows), so the output
// can go into docs/RESULTS.md without committing anything derived from the data.
//
// Definitions (N alerts, F firing groups, U alerts in no firing group):
//   queue reduction  = 1 − (F + U) / N   items a human looks at, vs one per alert
//   alert coverage   = (N − U) / N
//   purity (micro)   = Σ largest single-dataset count per firing group / Σ firing group sizes
//   fragmentation    = firing groups per dataset (median, max), over datasets with alerts
//   dataset coverage = datasets with ≥ 1 alert in a firing group / datasets with ≥ 1 alert
//   vacuity          = same-host dataset pairs whose alert times come within one window
//                      of each other: the only places a group could mix datasets at all.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { DEMO_MIN_DETECTORS, DEMO_WINDOW_MS, parseAlertLine, type Alert } from '../src/alertAdapter';
import { correlate, type Signal } from '../src/correlate';

const SEVERITY_WEIGHT = { low: 1, medium: 2, high: 3, critical: 5 } as const;
const HOUR = 60 * 60_000;

type Row = { alert: Alert; dataset: string; correlationKey: string };
type Variant = { name: string; signal: (r: Row) => Signal; windowMs: number; fires: number };

const hostKey = (r: Row): string => r.alert.host.toLowerCase();
const VARIANTS: Variant[] = [
  { name: 'headline: host, ≥2 detectors, 60 min', signal: (r) => ({ key: hostKey(r), source: r.alert.detectorId, time: r.alert.time, weight: 1 }), windowMs: DEMO_WINDOW_MS, fires: DEMO_MIN_DETECTORS },
  { name: 'window 30 min', signal: (r) => ({ key: hostKey(r), source: r.alert.detectorId, time: r.alert.time, weight: 1 }), windowMs: 0.5 * HOUR, fires: DEMO_MIN_DETECTORS },
  { name: 'window 120 min', signal: (r) => ({ key: hostKey(r), source: r.alert.detectorId, time: r.alert.time, weight: 1 }), windowMs: 2 * HOUR, fires: DEMO_MIN_DETECTORS },
  { name: 'baseline: host, no window', signal: (r) => ({ key: hostKey(r), source: r.alert.detectorId, time: r.alert.time, weight: 1 }), windowMs: Infinity, fires: DEMO_MIN_DETECTORS },
  { name: 'baseline: host + UTC day', signal: (r) => ({ key: `${hostKey(r)}|${new Date(r.alert.time).toISOString().slice(0, 10)}`, source: r.alert.detectorId, time: r.alert.time, weight: 1 }), windowMs: Infinity, fires: DEMO_MIN_DETECTORS },
  { name: "baseline: producer's correlation_key", signal: (r) => ({ key: r.correlationKey, source: r.alert.detectorId, time: r.alert.time, weight: 1 }), windowMs: DEMO_WINDOW_MS, fires: DEMO_MIN_DETECTORS },
  { name: 'severity-weighted 1/2/3/5, ≥4', signal: (r) => ({ key: hostKey(r), source: r.alert.detectorId, time: r.alert.time, weight: SEVERITY_WEIGHT[r.alert.severity] }), windowMs: DEMO_WINDOW_MS, fires: 4 },
];

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

function measure(rows: Row[], v: Variant) {
  const firing = correlate(rows.map(v.signal), v.windowMs).filter((g) => g.score >= v.fires);
  const n = rows.length;
  const inFiring = firing.reduce((sum, g) => sum + g.members.length, 0);
  const u = n - inFiring;
  let largest = 0;
  let impure = 0;
  const groupsPerDataset = new Map<string, number>(rows.map((r) => [r.dataset, 0]));
  for (const g of firing) {
    const counts = new Map<string, number>();
    for (const i of g.members) counts.set(rows[i].dataset, (counts.get(rows[i].dataset) ?? 0) + 1);
    largest += Math.max(...counts.values());
    if (counts.size > 1) impure++;
    for (const d of counts.keys()) groupsPerDataset.set(d, (groupsPerDataset.get(d) ?? 0) + 1);
  }
  const perDataset = [...groupsPerDataset.values()];
  return {
    variant: v.name,
    N: n,
    F: firing.length,
    U: u,
    queueReduction: n === 0 ? 0 : 1 - (firing.length + u) / n,
    alertCoverage: n === 0 ? 0 : (n - u) / n,
    purity: inFiring === 0 ? null : largest / inFiring,
    impureGroups: impure,
    fragmentationMedian: median(perDataset),
    fragmentationMax: Math.max(0, ...perDataset),
    datasetCoverage: `${perDataset.filter((c) => c > 0).length}/${perDataset.length}`,
  };
}

/** Same-host dataset pairs whose alert time ranges come within one window: where mixing is even possible. */
function vacuity(rows: Row[], windowMs: number): number {
  const ranges = new Map<string, { host: string; min: number; max: number }>();
  for (const r of rows) {
    const id = `${hostKey(r)}|${r.dataset}`;
    const range = ranges.get(id) ?? { host: hostKey(r), min: Infinity, max: -Infinity };
    ranges.set(id, { host: range.host, min: Math.min(range.min, r.alert.time), max: Math.max(range.max, r.alert.time) });
  }
  const list = [...ranges.values()];
  let pairs = 0;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const [a, b] = [list[i], list[j]];
      if (a.host === b.host && a.min - b.max <= windowMs && b.min - a.max <= windowMs) pairs++;
    }
  }
  return pairs;
}

function main(): number {
  const path = process.argv[2];
  let bytes: Buffer;
  try {
    bytes = readFileSync(path ?? '');
  } catch {
    process.stderr.write('usage: npm run eval:alerts -- <alerts.jsonl>\n');
    return 1;
  }
  const rows: Row[] = [];
  let skipped = 0;
  for (const line of bytes.toString('utf8').split('\n')) {
    if (line.trim() === '') continue;
    const alert = parseAlertLine(line);
    if (alert === null) { skipped++; continue; }
    const raw = JSON.parse(line) as { ground_truth?: { dataset_id?: string } | null; correlation_key?: unknown };
    rows.push({ alert, dataset: raw.ground_truth?.dataset_id ?? 'unlabelled', correlationKey: String(raw.correlation_key) });
  }
  process.stdout.write(`input sha256 ${createHash('sha256').update(bytes).digest('hex')}\n`);
  process.stdout.write(`${rows.length} alerts, ${skipped} skipped by the guard, ${new Set(rows.map((r) => r.dataset)).size} datasets, ${new Set(rows.map(hostKey)).size} hosts\n`);
  process.stdout.write(`vacuity: ${vacuity(rows, DEMO_WINDOW_MS)} same-host dataset pairs within 60 min of each other\n\n`);
  const fmt = (x: number | null): string => (x === null ? 'n/a' : x.toFixed(3));
  process.stdout.write('| variant | N | F | U | items for a human (F + U) | queue reduction | alert coverage | purity | impure groups | fragmentation median / max | dataset coverage |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n');
  for (const v of VARIANTS) {
    const m = measure(rows, v);
    process.stdout.write(`| ${m.variant} | ${m.N} | ${m.F} | ${m.U} | ${m.F + m.U} | ${fmt(m.queueReduction)} | ${fmt(m.alertCoverage)} | ${fmt(m.purity)} | ${m.impureGroups} | ${m.fragmentationMedian} / ${m.fragmentationMax} | ${m.datasetCoverage} |\n`);
  }
  return 0;
}

process.exit(main());
