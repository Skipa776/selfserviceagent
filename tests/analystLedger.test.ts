import { afterEach, describe, expect, it } from 'vitest';

import { SqliteAnalystLedger } from '../src/analyst/ledger';
import type { ReportEvent } from '../src/contracts/types';

const ledgers: SqliteAnalystLedger[] = [];
const event = (overrides: Partial<ReportEvent> = {}): ReportEvent => ({
  ts: '2026-09-11T12:00:00.000Z',
  correlationId: 'corr-1',
  service: 'classroom_av',
  scope: 'location',
  location: 'Lecture Hall West',
  building: 'LHW',
  room: '',
  symptom: 'equipment_unavailable',
  observedAt: '',
  reporterHash: 'reporter-a',
  outcome: 'FILE_INCIDENT',
  ticketNumber: 'INC001',
  viaOverride: false,
  ...overrides,
});

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
});

describe('SQLite analyst ledger', () => {
  it('appends events in one durable sequence', () => {
    const ledger = new SqliteAnalystLedger(':memory:');
    ledgers.push(ledger);
    expect(ledger.append(event())).toBe(1);
    expect(ledger.append(event({ correlationId: 'corr-2', reporterHash: 'reporter-b' }))).toBe(2);
    expect(ledger.list()).toEqual([event(), event({ correlationId: 'corr-2', reporterHash: 'reporter-b' })]);
    expect(ledger.watermark()).toBe(2);
  });

  it('treats an identical correlation replay as a no-op', () => {
    const ledger = new SqliteAnalystLedger(':memory:');
    ledgers.push(ledger);
    expect(ledger.append(event())).toBe(1);
    expect(ledger.append(event())).toBe(1);
    expect(ledger.list()).toHaveLength(1);
  });

  it('rejects conflicting evidence for one correlation ID', () => {
    const ledger = new SqliteAnalystLedger(':memory:');
    ledgers.push(ledger);
    ledger.append(event());
    expect(() => ledger.append(event({ reporterHash: 'different' }))).toThrow('conflicting analyst event');
  });

  it('exposes no update or delete operation', () => {
    const ledger = new SqliteAnalystLedger(':memory:');
    ledgers.push(ledger);
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(ledger));
    expect(methods).not.toContain('update');
    expect(methods).not.toContain('delete');
    expect(methods).not.toContain('clear');
  });
});
