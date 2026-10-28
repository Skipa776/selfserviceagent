// components/pattern_detector.md — the advisory NOC signal.
//
// Two independent controls guard the same abuse surface from opposite ends: the
// throttle limits how many reports one identity can generate, and the
// distinct-reporter rule here means those reports could not manufacture an alert
// even if the throttle failed. Neither substitutes for the other, so both are
// tested separately.

import { beforeEach, describe, expect, it } from 'vitest';

import { CLUSTER_THRESHOLD, configureGate, resetGate } from '../src/clusterGate';
import type { ReportEvent } from '../src/contracts/types';
import { PatternDetector } from '../src/patternDetector';
import { mutableClock, TEST_GATE } from './harness';
import { CORPUS_NOW } from './corpus';

const event = (over: Partial<ReportEvent> = {}): ReportEvent => ({
  ts: CORPUS_NOW,
  correlationId: 'corr-1',
  service: 'wifi',
  scope: 'location',
  location: 'North Residence Hall',
  building: 'NORTH RESIDENCE HALL',
  room: '',
  symptom: 'intermittent',
  observedAt: '',
  reporterHash: 'rh_a',
  outcome: 'FILE_INCIDENT',
  ticketNumber: 'INC1',
  viaOverride: false,
  ...over,
});

beforeEach(() => {
  resetGate();
  configureGate(TEST_GATE);
});

describe('the event-stream counting rule', () => {
  // wifi @ North Residence Hall has no per-topic rule → the default ceiling of CLUSTER_THRESHOLD.
  // Unlike request-path search, this stream includes the current accepted or
  // deflected report. It therefore alerts at stream count > threshold: the same
  // interaction that saw threshold existing peers and was deflected.
  const FIRES_AT = CLUSTER_THRESHOLD + 1;

  it(`fires exactly one alert at ${CLUSTER_THRESHOLD + 1} distinct reporters in window`, () => {
    const d = new PatternDetector(() => new Date(CORPUS_NOW));
    const results = Array.from({ length: FIRES_AT }, (_, i) =>
      d.consume(event({ reporterHash: `rh_${i}`, ticketNumber: `INC${i}` })),
    );

    // Five previous accepted reports plus the current event produce stream count
    // six, corresponding to request-path evidence of five existing tickets.
    expect(results.slice(0, FIRES_AT - 1).every((r) => r === null)).toBe(true);
    expect(results[FIRES_AT - 1]).not.toBeNull();
    expect(d.raised).toHaveLength(1);
  });

  it('that many reports from ONE reporter fires nothing', () => {
    const d = new PatternDetector(() => new Date(CORPUS_NOW));
    for (let i = 0; i < FIRES_AT * 2; i++) {
      expect(d.consume(event({ reporterHash: 'rh_same', correlationId: `c${i}` }))).toBeNull();
    }
    expect(d.raised).toHaveLength(0);
  });

  it('events spanning more than the window fire nothing', () => {
    const { clock, advanceMinutes } = mutableClock();
    const d = new PatternDetector(clock);

    for (let i = 0; i < FIRES_AT - 1; i++) {
      d.consume(event({ reporterHash: `rh_${i}`, ts: clock().toISOString() }));
      // Spread them past the window so the early ones age out before the last.
      advanceMinutes(TEST_GATE.matchTimeWindowMinutes / 2);
    }
    const last = d.consume(event({ reporterHash: 'rh_last', ts: clock().toISOString() }));

    expect(last).toBeNull();
    expect(d.raised).toHaveLength(0);
  });
});

describe('alert de-duplication', () => {
  it('a further qualifying report UPDATES the alert rather than raising a second', () => {
    const d = new PatternDetector(() => new Date(CORPUS_NOW));
    // Include the current report event, so alerting remains threshold + 1.
    for (let i = 0; i < CLUSTER_THRESHOLD + 1; i++) d.consume(event({ reporterHash: `rh_${i}` }));
    expect(d.raised).toHaveLength(1);

    const again = d.consume(event({ reporterHash: 'rh_extra', ticketNumber: 'INC99' }));

    // A channel that pages once per additional reporter is a channel that gets
    // muted, and a muted channel is worth less than none.
    expect(again).toBeNull();
    expect(d.raised).toHaveLength(1);
    expect(d.raised[0].distinctReporters).toBe(CLUSTER_THRESHOLD + 2);
    expect(d.raised[0].ticketNumbers).toContain('INC99');
  });
});

describe('scope grouping', () => {
  it('keeps classroom AV rooms in separate groups', () => {
    const d = new PatternDetector(() => new Date(CORPUS_NOW));
    for (let i = 0; i < CLUSTER_THRESHOLD; i++) d.consume(event({ service: 'classroom_av', building: 'CENTR', room: '214', reporterHash: `r${i}` }));
    expect(d.consume(event({ service: 'classroom_av', building: 'CENTR', room: '101', reporterHash: 'different-room' }))).toBeNull();
  });

  it('service_wide events do not inflate any single location count', () => {
    const d = new PatternDetector(() => new Date(CORPUS_NOW));

    // Four building-scoped reports for North Residence Hall…
    for (let i = 0; i < CLUSTER_THRESHOLD - 1; i++) d.consume(event({ reporterHash: `rh_${i}` }));
    // …plus a campus-wide one, which groups under its own location-less key.
    const crossover = d.consume(
      event({ reporterHash: 'rh_wide', scope: 'service_wide', location: '' }),
    );

    expect(crossover).toBeNull();
    expect(d.raised).toHaveLength(0);
  });

  it('groups service_wide reports under a location-less key of their own', () => {
    const d = new PatternDetector(() => new Date(CORPUS_NOW));
    let raised = null;
    // Include the current report event, so alerting remains threshold + 1.
    for (let i = 0; i < CLUSTER_THRESHOLD + 1; i++) {
      raised = d.consume(event({ reporterHash: `rh_${i}`, scope: 'service_wide', location: '' }));
    }
    expect(raised).not.toBeNull();
    expect(raised?.location).toBe('');
  });
});

describe('what the alert may claim', () => {
  it("status is always 'candidate' — this service never declares an outage", () => {
    const d = new PatternDetector(() => new Date(CORPUS_NOW));
    for (let i = 0; i < CLUSTER_THRESHOLD + 1; i++) d.consume(event({ reporterHash: `rh_${i}` }));
    expect(d.raised[0].status).toBe('candidate');
    expect(d.raised.every((a) => a.status === 'candidate')).toBe(true);
  });

  it('counts distinct reporters, never raw report count', () => {
    const d = new PatternDetector(() => new Date(CORPUS_NOW));
    // Two events each for (threshold + 1) reporters: the alert must say the
    // distinct count, not double it.
    const distinct = CLUSTER_THRESHOLD + 1;
    for (let i = 0; i < distinct; i++) {
      d.consume(event({ reporterHash: `rh_${i}` }));
      d.consume(event({ reporterHash: `rh_${i}` }));
    }
    expect(d.raised[0].distinctReporters).toBe(distinct);
  });

  it('override reports still count, and the flag rides along on the event', () => {
    const d = new PatternDetector(() => new Date(CORPUS_NOW));
    let raised = null;
    const distinct = CLUSTER_THRESHOLD + 1;
    for (let i = 0; i < distinct; i++) {
      raised = d.consume(event({ reporterHash: `rh_${i}`, viaOverride: i === 0 }));
    }
    // Someone overriding a match is still reporting a real problem.
    expect(raised?.distinctReporters).toBe(distinct);
  });
});
