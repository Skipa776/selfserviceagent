// The opt-in audit file (AUDIT_LOG_PATH): one JSON line per audit line.

import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { auditFileSink, buildStage1 } from '../src/composition';
import { handleReport } from '../src/orchestrator';
import { CORPUS_NOW } from './corpus';

describe('auditFileSink', () => {
  it('is off when AUDIT_LOG_PATH is unset or blank', () => {
    expect(auditFileSink(undefined)).toBeUndefined();
    expect(auditFileSink('  ')).toBeUndefined();
  });

  it('appends every audit line of a request as JSONL', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'audit-')), 'audit.jsonl');
    const system = buildStage1({ clock: () => new Date(CORPUS_NOW), auditSink: auditFileSink(path) });
    await handleReport({ text: 'wifi in North Residence Hall keeps dropping', identityRef: 'r1', canFollowUp: true }, system.deps);
    const lines = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { action: string });
    expect(lines.map((l) => l.action)).toEqual(system.audit.lines.map((l) => l.action));
  });

  it('creates the file readable by its owner only', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'audit-')), 'audit.jsonl');
    auditFileSink(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('fails at startup, not mid-request, when the path cannot be written', () => {
    expect(() => auditFileSink(join(tmpdir(), 'no-such-dir', 'audit.jsonl'))).toThrow();
  });
});
