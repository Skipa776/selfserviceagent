// Loader for the hand-written test set (data/handwritten/README.md has the
// format). Not a test file: scripts/evalLlm.ts uses it, and so will the
// Milestone 2 router evaluation.

import { readFileSync } from 'node:fs';

import { SCOPES, SERVICES, SYMPTOMS, type ReportScope, type Service, type Symptom } from '../src/vocab/catalog';
import { canonicalBuilding, canonicalLocation } from '../src/vocab/locations';
import type { EvalRow } from './corpus';

/** The rows, or null while the file is still the marked placeholder. Throws on a bad row, naming its line. */
export function loadHandwrittenSet(path: string): EvalRow[] | null {
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0 || '_placeholder' in (JSON.parse(lines[0]) as object)) return null;

  const ids = new Set<string>();
  return lines.map((text, i) => {
    const fail = (why: string): never => {
      throw new Error(`${path}:${i + 1}: ${why}`);
    };
    let row: Record<string, unknown> = {};
    try {
      row = JSON.parse(text) as Record<string, unknown>;
    } catch {
      fail('not valid JSON');
    }
    if (typeof row.id !== 'string' || row.id === '' || ids.has(row.id)) fail('id must be a unique string');
    ids.add(row.id as string);
    if (typeof row.text !== 'string' || row.text.trim() === '') fail('text is required');
    const services = Array.isArray(row.service) ? row.service : [row.service];
    if (!services.every((s) => (SERVICES as readonly unknown[]).includes(s))) fail(`service ${JSON.stringify(row.service)} is not in the catalog`);
    if (!(SCOPES as readonly unknown[]).includes(row.scope)) fail(`scope ${String(row.scope)} is not in the catalog`);
    if (!(SYMPTOMS as readonly unknown[]).includes(row.symptom)) fail(`symptom ${String(row.symptom)} is not in the catalog`);
    for (const field of ['location', 'building', 'room']) {
      if (typeof row[field] !== 'string') fail(`${field} must be a string ('' when not stated)`);
    }
    // A typo here would silently mark every parser wrong on this row.
    if (row.location !== '' && canonicalLocation(row.location) !== row.location) fail(`location ${String(row.location)} is not canonical`);
    if (row.building !== '' && canonicalBuilding(row.building) !== row.building) fail(`building ${String(row.building)} is not a canonical code`);
    return {
      id: row.id as string,
      groupId: typeof row.groupId === 'string' ? row.groupId : (row.id as string),
      input: row.text as string,
      service: row.service as Service | Service[],
      scope: row.scope as ReportScope,
      location: row.location as string,
      building: row.building as string,
      room: row.room as string,
      symptom: row.symptom as Symptom,
    };
  });
}
