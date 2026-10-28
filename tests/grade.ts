// Shared grading for every parser measurement (report_corpus.md, test_matrix.md).
//
// Not a test file. Extracted so the three places that score a parser — the
// stage-1 baseline (eval.test.ts), the stage-2 parity run (parity.test.ts) and
// the live eval (scripts/evalLlm.ts) — grade IDENTICALLY. A parity comparison
// where each side counts differently measures the grader, not the parsers.

import type { ProblemReport } from '../src/contracts/types';
import type { EvalRow } from './corpus';

export type FieldResult = {
  readonly field: string;
  readonly expected: string;
  readonly actual: string;
  readonly ok: boolean;
};

export type RowResult = { readonly row: EvalRow; readonly report?: ProblemReport; readonly fields: readonly FieldResult[] };

/**
 * Six graded fields per row: service, scope, location, building, room, and
 * symptom. Group consistency is measured separately because the canonical
 * grouping key is derived from the fields that matching uses, not from the prose
 * or row id.
 *
 * `verbatim` and `observedAt` are deliberately not graded. `verbatim` is the
 * input echoed back, so grading it measures nothing; `observedAt` has no corpus
 * row that exercises it (keyword_extractor.md). Adding either would move the
 * percentage without changing what is known.
 *
 * A row may list several acceptable services only when the contract explicitly
 * allows several labels. Genuinely unresolved service ambiguity uses `unknown`.
 */
export function gradeRow(row: EvalRow, got: ProblemReport): FieldResult[] {
  const services = Array.isArray(row.service) ? row.service : [row.service];
  return [
    {
      field: 'service',
      expected: services.join('|'),
      actual: got.service,
      ok: services.includes(got.service as (typeof services)[number]),
    },
    { field: 'scope', expected: row.scope, actual: got.scope, ok: got.scope === row.scope },
    { field: 'location', expected: row.location, actual: got.location, ok: got.location === row.location },
    { field: 'building', expected: row.building, actual: got.building, ok: got.building === row.building },
    { field: 'room', expected: row.room, actual: got.room, ok: got.room === row.room },
    { field: 'symptom', expected: row.symptom, actual: got.symptom, ok: got.symptom === row.symptom },
  ];
}

export function groupingKey(report: Pick<ProblemReport, 'service' | 'scope' | 'building' | 'room'>): string {
  const room = report.service === 'classroom_av' ? report.room : '';
  return [report.service, report.scope, report.building, room].join('|');
}

export function expectedGroupingKey(row: EvalRow): string {
  const service = Array.isArray(row.service) && row.service.length > 1 ? 'unknown' : (row.service as string);
  return groupingKey({ service, scope: row.scope, building: row.building, room: row.room });
}

export type GroupConsistency = {
  readonly groups: number;
  readonly consistentGroups: number;
  readonly rows: number;
  readonly consistentRows: number;
  readonly ok: boolean;
};

export function repeatableRuns(
  runs: ReadonlyArray<ReadonlyArray<{ readonly fields: readonly FieldResult[] }>>,
): boolean {
  const first = runs[0];
  return first !== undefined && runs.every((run) => run.length === first.length && run.every((row, index) =>
    row.fields.every((field, fieldIndex) => field.actual === first[index]?.fields[fieldIndex]?.actual),
  ));
}

/** Every row in a family must resolve to that family's expected matching key. */
export function groupConsistency(
  results: readonly (RowResult & { readonly report: ProblemReport })[],
): GroupConsistency {
  const byGroup = new Map<string, Array<RowResult & { readonly report: ProblemReport }>>();
  for (const result of results) {
    const rows = byGroup.get(result.row.groupId) ?? [];
    rows.push(result);
    byGroup.set(result.row.groupId, rows);
  }
  let consistentGroups = 0;
  let consistentRows = 0;
  for (const rows of byGroup.values()) {
    const ok = rows.every(({ row, report }) => groupingKey(report) === expectedGroupingKey(row));
    if (ok) {
      consistentGroups++;
      consistentRows += rows.length;
    }
  }
  return {
    groups: byGroup.size,
    consistentGroups,
    rows: results.length,
    consistentRows,
    ok: consistentRows === results.length,
  };
}

export type Score = {
  readonly correct: number;
  readonly total: number;
  readonly exactRows: number;
  readonly rows: number;
  readonly groupConsistency: GroupConsistency;
};

export function score(results: readonly RowResult[]): Score {
  return {
    correct: results.reduce((n, r) => n + r.fields.filter((f) => f.ok).length, 0),
    total: results.length * 6,
    exactRows: results.filter((r) => r.fields.every((f) => f.ok)).length,
    rows: results.length,
    groupConsistency: groupConsistency(results as (RowResult & { readonly report: ProblemReport })[]),
  };
}

/** The shared report block, so baseline and LLM numbers are read side by side. */
export function formatScore(label: string, results: readonly RowResult[]): string {
  const s = score(results);
  return [
    '',
    `  ── ${label} ${'─'.repeat(Math.max(0, 62 - label.length))}`,
    `  fields correct : ${s.correct}/${s.total}  (${((s.correct / s.total) * 100).toFixed(1)}%)`,
    `  rows exact     : ${s.exactRows}/${s.rows}`,
    `  groups         : ${s.groupConsistency.consistentGroups}/${s.groupConsistency.groups} consistent`,
    '  misses:',
    ...results.flatMap(({ row, fields }) => {
      const bad = fields.filter((f) => !f.ok);
      if (bad.length === 0) return [];
      return [
        `    "${row.input}"`,
        ...bad.map((f) => `        ${f.field}: expected ${f.expected}, got ${f.actual}`),
      ];
    }),
    '  ─────────────────────────────────────────────────────────────────────────',
    '',
  ].join('\n');
}
