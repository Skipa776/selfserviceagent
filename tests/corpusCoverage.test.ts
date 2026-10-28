import { describe, expect, it } from 'vitest';

import { EVAL_ROWS } from './corpus';
import { expectedGroupingKey, groupingKey, repeatableRuns } from './grade';
import { parseReport } from '../src/parser/reportParser';

describe('expanded synthetic corpus invariants', () => {
  it('has unique stable row and group identifiers', () => {
    expect(new Set(EVAL_ROWS.map((row) => row.id)).size).toBe(EVAL_ROWS.length);
    expect(EVAL_ROWS.every((row) => /^[a-z0-9-]+$/.test(row.id))).toBe(true);
    expect(EVAL_ROWS.every((row) => /^[a-z0-9-]+$/.test(row.groupId))).toBe(true);
  });

  it('covers every reporter role and every service, including unknown', () => {
    expect(new Set(EVAL_ROWS.map((row) => row.role))).toEqual(new Set(['student', 'faculty', 'staff']));
    const services = new Set(EVAL_ROWS.flatMap((row) => Array.isArray(row.service) ? row.service : [row.service]));
    expect(services).toEqual(new Set(['wifi', 'wired_network', 'vpn', 'web_portal', 'classroom_av', 'unknown']));
  });

  it('keeps ambiguity controls explicit and unknown rather than guessed', () => {
    const genericPortal = EVAL_ROWS.find((row) => row.id === 'portal-generic-ambiguous-02');
    const genericInternet = EVAL_ROWS.find((row) => row.id === 'portal-main-library-ambiguous-02');
    expect(genericPortal?.scope).toBe('unknown');
    expect(genericInternet?.service).toBe('unknown');
    expect(parseReport(genericInternet!.input).service).toBe('unknown');
  });

  it('keeps roomless and room-specific Lecture Hall AV families distinct', () => {
    const roomless = EVAL_ROWS.find((row) => row.id === 'av-center-roomless-01')!;
    const roomSpecific = EVAL_ROWS.find((row) => row.id === 'av-center-room-01')!;
    expect(expectedGroupingKey(roomless)).not.toBe(expectedGroupingKey(roomSpecific));
    expect(groupingKey({ service: 'classroom_av', scope: 'location', building: 'LECT', room: '' }))
      .not.toBe(groupingKey({ service: 'classroom_av', scope: 'location', building: 'LECT', room: '214' }));
  });

  it('grades identical recorded runs as repeatable', () => {
    const fields = [{ field: 'service', expected: 'wifi', actual: 'wifi', ok: true }];
    expect(repeatableRuns([
      [{ fields }],
      [{ fields: [...fields] }],
      [{ fields: [...fields] }],
    ])).toBe(true);
    expect(repeatableRuns([
      [{ fields }],
      [{ fields: [{ ...fields[0]!, actual: 'vpn', ok: false }] }],
    ])).toBe(false);
  });
});
