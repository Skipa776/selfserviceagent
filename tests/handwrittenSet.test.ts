import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadHandwrittenSet } from './handwrittenSet';

const write = (lines: readonly object[]): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'handwritten-')), 'reports.jsonl');
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return path;
};

const ROW = {
  id: 'hw-001', text: 'the wifi in North Residence Hall keeps dropping', service: 'wifi', scope: 'location',
  location: 'North Residence Hall', building: 'NORTH RESIDENCE HALL', room: '', symptom: 'intermittent', frustrated: false,
};

describe('the hand-written test set loader', () => {
  it('reports the committed file as a placeholder, so nothing scores it', () => {
    const committed = fileURLToPath(new URL('../data/handwritten/reports.jsonl', import.meta.url));
    expect(loadHandwrittenSet(committed)).toBeNull();
  });

  it('turns a row into the grader\'s shape', () => {
    expect(loadHandwrittenSet(write([ROW]))).toEqual([{
      id: 'hw-001', groupId: 'hw-001', input: ROW.text, service: 'wifi', scope: 'location',
      location: 'North Residence Hall', building: 'NORTH RESIDENCE HALL', room: '', symptom: 'intermittent',
    }]);
  });

  it('names the line of a bad row', () => {
    expect(() => loadHandwrittenSet(write([ROW, { ...ROW, id: 'hw-002', service: 'WiFi' }]))).toThrow(/:2: service/);
    expect(() => loadHandwrittenSet(write([ROW, ROW]))).toThrow(/:2: id must be a unique string/);
    expect(() => loadHandwrittenSet(write([{ ...ROW, building: 'NRH' }]))).toThrow(/:1: building NRH is not a canonical code/);
    const path = write([ROW]);
    writeFileSync(path, `${JSON.stringify(ROW)}\n{"id": "hw-002", "text": oops}\n`);
    expect(() => loadHandwrittenSet(path)).toThrow(/:2: not valid JSON/);
  });
});
