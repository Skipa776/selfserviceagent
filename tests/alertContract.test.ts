// The security-alert contract with Skipa776/detection-engineering-ml (Milestone 3).
//
// Two definitions of "a valid alert" exist on purpose: the producer's JSON
// Schema (checked here with ajv, a dev-only dependency) and the adapter's
// runtime guard (hand-written, stricter, no dependency). These tests keep them
// from drifting apart and pin the vendored files byte for byte.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';

import { incidentCandidates, parseAlertLine, parseAlerts } from '../src/alertAdapter';
import { printable } from '../scripts/triageAlerts';

const vendored = (name: string): string => fileURLToPath(new URL(`../vendor/detection-engineering-ml/${name}`, import.meta.url));
const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
const schema = JSON.parse(readFileSync(vendored('alert.schema.json'), 'utf8'));
const lines = readFileSync(vendored('alerts.synthetic.jsonl'), 'utf8').split('\n').filter((l) => l.trim() !== '');
const validate = new Ajv2020({ strict: false }).compile(schema);

describe('the vendored contract (vendor/detection-engineering-ml/PROVENANCE.md)', () => {
  it('is byte-for-byte the pinned upstream copy', () => {
    expect(sha256(vendored('alert.schema.json'))).toBe('ac822da078b983d46ca2af344623a0fb5a05c72344cef4d019672328c98cbc66');
    expect(sha256(vendored('alerts.synthetic.jsonl'))).toBe('3aefd54caaec0afe4148dd5fc3c833479366a7da1d8ab8a964abefbc9e56204b');
  });

  it('every SYNTHETIC fixture alert passes the schema AND the runtime guard', () => {
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      expect(validate(JSON.parse(line)), JSON.stringify(validate.errors)).toBe(true);
      expect(parseAlertLine(line)).not.toBeNull();
    }
  });

  it('what the schema rejects, the guard rejects too', () => {
    const base = JSON.parse(lines[0]);
    const mutations: Record<string, (a: Record<string, unknown>) => void> = {
      'schema_version 1.1': (a) => { a.schema_version = '1.1'; },
      'missing alert_id': (a) => { delete a.alert_id; },
      'short alert_id': (a) => { a.alert_id = 'abc'; },
      'unknown severity': (a) => { a.severity = 'urgent'; },
      'time without milliseconds': (a) => { a.time_observed = '2020-09-04T20:09:38Z'; },
      'empty host': (a) => { (a.entity as Record<string, unknown>).host = ''; },
      'bad technique id': (a) => { a.techniques = ['TA0001']; },
      'unknown detector type': (a) => { (a.detector as Record<string, unknown>).type = 'yara'; },
    };
    for (const [name, mutate] of Object.entries(mutations)) {
      const alert = structuredClone(base);
      mutate(alert);
      expect(validate(alert), `schema should reject: ${name}`).toBe(false);
      expect(parseAlertLine(JSON.stringify(alert)), `guard should reject: ${name}`).toBeNull();
    }
  });

  it('the guard is stricter than the schema where untrusted text becomes keys or output', () => {
    const base = JSON.parse(lines[0]);
    for (const host of ['WS1\nWS2', 'WS1|evil', '\u001b[31mWS1', 'x'.repeat(65)]) {
      const alert = structuredClone(base);
      alert.entity.host = host;
      expect(validate(alert)).toBe(true); // the schema allows any non-empty host
      expect(parseAlertLine(JSON.stringify(alert))).toBeNull(); // the guard does not
    }
    expect(parseAlerts(`${lines[0]}\nnot json\n${'x'.repeat(70_000)}\n`)).toMatchObject({ skipped: 2 });
  });

  it('the parsed alert carries none of the untrusted or evaluation-only fields', () => {
    const alert = parseAlertLine(lines[0]) as Record<string, unknown>;
    for (const field of ['ground_truth', 'evidence', 'title', 'correlation_key', 'user', 'process']) expect(alert).not.toHaveProperty(field);
  });
});

describe('incident candidates on the SYNTHETIC fixture', () => {
  const { alerts } = parseAlerts(lines.join('\n'));

  it('WS1 and WS3 fire (two detectors each, inside an hour); WS2 (one detector) does not', () => {
    const { candidates, alertsInNoCandidate } = incidentCandidates(alerts);
    expect(candidates.map((c) => c.host)).toEqual(['SYNTHETIC-WS1', 'SYNTHETIC-WS3']);
    expect(candidates.every((c) => c.distinctDetectors === 2)).toBe(true);
    expect(alertsInNoCandidate).toBe(1);
  });

  it('names every Sigma rule author, as the Detection Rule License requires', () => {
    const [ws1] = incidentCandidates(alerts).candidates;
    expect(ws1.detectors.map((d) => d.author)).toEqual(['SYNTHETIC Author One', 'SYNTHETIC Author Two']);
  });

  it('ground truth and event refs cannot steer the grouping', () => {
    const scrambled = lines.map((line, i) => {
      const a = JSON.parse(line);
      delete a.ground_truth;
      a.evidence.event_refs = [`OTHER-${i}:99`];
      return JSON.stringify(a);
    });
    expect(incidentCandidates(parseAlerts(scrambled.join('\n')).alerts)).toEqual(incidentCandidates(alerts));
  });
});

describe('what the triage CLI prints', () => {
  it('strips control codes and bidi overrides, and caps the length', () => {
    expect(printable('rule\u001b[31m red\u0007\u202e evil')).toBe('rule[31m red evil');
    expect(printable('x'.repeat(500))).toHaveLength(120);
  });
});

