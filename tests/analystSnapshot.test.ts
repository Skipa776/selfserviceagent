import { describe, expect, it } from 'vitest';

import type { ReportEvent } from '../src/contracts/types';
import { buildEvidenceSnapshots, topicKeyFor } from '../src/analyst/evidence';

const event = (overrides: Partial<ReportEvent> = {}): ReportEvent => ({
  ts: '2026-09-11T12:00:00.000Z',
  correlationId: 'corr-1',
  service: 'classroom_av',
  scope: 'location',
  location: 'Lecture Hall West',
  building: 'WLH',
  room: '',
  symptom: 'equipment_unavailable',
  observedAt: '',
  reporterHash: 'reporter-a',
  outcome: 'FILE_INCIDENT',
  ticketNumber: 'INC001',
  viaOverride: false,
  ...overrides,
});

describe('analyst evidence snapshots', () => {
  it('groups events by the deterministic operational topic', () => {
    expect(topicKeyFor(event())).toBe('classroom_av|location|WLH||equipment_unavailable');
  });

  it('counts distinct filed, overflow, and override reporters separately', () => {
    const snapshots = buildEvidenceSnapshots([
      event(),
      event({ correlationId: 'corr-2', reporterHash: 'reporter-b', ticketNumber: 'INC002' }),
      event({
        correlationId: 'corr-3', reporterHash: 'reporter-c', outcome: 'MATCHED_CLUSTER', ticketNumber: '',
      }),
      event({
        correlationId: 'corr-4', reporterHash: 'reporter-d', ticketNumber: 'INC003', viaOverride: true,
      }),
      event({
        correlationId: 'corr-5', reporterHash: 'reporter-d', ticketNumber: 'INC004', viaOverride: true,
      }),
    ], '2026-09-11T12:05:00.000Z');

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      filedDistinct: 3,
      overflowDistinct: 1,
      overrideDistinct: 1,
      totalDistinct: 4,
      filedTicketNumbers: ['INC001', 'INC002', 'INC003', 'INC004'],
    });
    expect(snapshots[0].evidence.map((item) => item.id)).toEqual([
      'E1', 'E2', 'E3', 'E4', 'E5',
    ]);
  });

  it('does not add category totals when one reporter appears in multiple sets', () => {
    const snapshots = buildEvidenceSnapshots([
      event({ reporterHash: 'same', viaOverride: true }),
      event({ correlationId: 'corr-2', reporterHash: 'same', outcome: 'MATCHED_CLUSTER', ticketNumber: '' }),
    ], '2026-09-11T12:05:00.000Z');

    expect(snapshots[0]).toMatchObject({ filedDistinct: 1, overflowDistinct: 1, overrideDistinct: 1, totalDistinct: 1 });
  });

  it('is deterministic regardless of input ordering', () => {
    const first = event();
    const second = event({ correlationId: 'corr-2', reporterHash: 'reporter-b', ticketNumber: 'INC002' });

    const a = buildEvidenceSnapshots([first, second], '2026-09-11T12:05:00.000Z')[0];
    const b = buildEvidenceSnapshots([second, first], '2026-09-11T12:05:00.000Z')[0];

    expect(a.snapshotId).toBe(b.snapshotId);
    expect(a.evidence).toEqual(b.evidence);
  });

  it('rejects duplicate correlation IDs with conflicting evidence', () => {
    expect(() => buildEvidenceSnapshots([
      event(),
      event({ reporterHash: 'different' }),
    ], '2026-09-11T12:05:00.000Z')).toThrow('conflicting analyst event');
  });
});
