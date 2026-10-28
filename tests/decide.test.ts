// decide() — the pure routing decision (decision.md). These tests pin every
// invariant the four branches must satisfy.
//
// Constants are INJECTED here (cluster_gate.md: source ships no default). We set a
// score threshold of 0.5 for the whole file. The COUNT threshold is now per-topic
// and arrives INSIDE evidence.peers (clusterThreshold) — decide() holds no count
// literal. Tests inject it via the `peers()` helper, defaulting to CLUSTER_THRESHOLD
// so the boundary tests track the real base number.
//
// SEMANTICS: distinctReporters counts matching tickets ALREADY returned by search.
// At threshold 5, four existing tickets allow filing; five existing tickets
// suppress creation of the next ticket.

import { beforeEach, describe, it, expect } from 'vitest';
import { decide, type Evidence } from '../src/decide';
import { CLUSTER_THRESHOLD, configureGate, resetGate } from '../src/clusterGate';
import type { ProblemReport, ReportScope } from '../src/contracts/types';

const THRESHOLD = 0.5;

beforeEach(() => {
  resetGate();
  // matchTimeWindowMinutes is irrelevant to decide() (it consumes the boolean
  // withinWindow, not minutes) but GateTuning requires it — any value is fine.
  configureGate({ matchScoreThreshold: THRESHOLD, matchTimeWindowMinutes: 120 });
});

/** A minimal report; only `scope` matters to decide() (branch 4 reads it). */
function report(scope: ReportScope): ProblemReport {
  return {
    service: 'wifi',
    scope,
    location: scope === 'location' ? 'main library' : '',
    symptom: 'no_connection',
    observedAt: '',
    verbatim: 'synthetic fixture',
    building: '',
    room: '',
  };
}

const declared = (matchScore: number, withinWindow: boolean): Evidence['declared'] => ({
  matchScore,
  withinWindow,
});
const peers = (
  matchScore: number,
  withinWindow: boolean,
  distinctReporters: number,
  clusterThreshold: number = CLUSTER_THRESHOLD,
): Evidence['peers'] => ({ matchScore, withinWindow, distinctReporters, clusterThreshold });

const NO_EVIDENCE: Evidence = { declared: null, peers: null };

describe('decide() — branch 1: override', () => {
  it('files instead of matching, even when a declared incident would deflect', () => {
    const ev: Evidence = { declared: declared(0.99, true), peers: null };
    const d = decide(report('location'), ev, true);
    expect(d.outcome).toBe('FILE_INCIDENT'); // location → INC; NOT MATCHED_DECLARED
  });

  it('files instead of matching, even when a full peer cluster would deflect', () => {
    const ev: Evidence = { declared: null, peers: peers(0.99, true, CLUSTER_THRESHOLD) };
    const d = decide(report('individual'), ev, true);
    expect(d.outcome).toBe('FILE_REQUEST'); // individual → REQ
  });
});

describe('decide() — branch 2: declared incident', () => {
  it('deflects a matching declared incident within window', () => {
    const d = decide(report('location'), { declared: declared(0.9, true), peers: null }, false);
    expect(d.outcome).toBe('MATCHED_DECLARED');
  });

  it('score boundary is inclusive (score === threshold deflects)', () => {
    const d = decide(report('location'), { declared: declared(THRESHOLD, true), peers: null }, false);
    expect(d.outcome).toBe('MATCHED_DECLARED');
  });

  it('files when the declared score is below threshold', () => {
    const d = decide(report('location'), { declared: declared(THRESHOLD - 0.01, true), peers: null }, false);
    expect(d.outcome).toBe('FILE_INCIDENT');
  });

  it('files when the declared match is outside the window', () => {
    const d = decide(report('location'), { declared: declared(0.9, false), peers: null }, false);
    expect(d.outcome).toBe('FILE_INCIDENT');
  });

  it('short-circuits: a declared match wins even when peers would ALSO deflect', () => {
    // The count is never consulted in branch 2. Declared + a full cluster present →
    // still MATCHED_DECLARED, never MATCHED_CLUSTER.
    const ev: Evidence = {
      declared: declared(0.9, true),
      peers: peers(0.99, true, CLUSTER_THRESHOLD + 3),
    };
    const d = decide(report('service_wide'), ev, false);
    expect(d.outcome).toBe('MATCHED_DECLARED');
  });
});

describe('decide() — branch 3: existing peer cluster', () => {
  it('deflects when existing distinct reporters reach the ceiling', () => {
    const ev: Evidence = { declared: null, peers: peers(0.9, true, CLUSTER_THRESHOLD) };
    const d = decide(report('location'), ev, false);
    expect(d.outcome).toBe('MATCHED_CLUSTER');
  });

  it('files with one fewer existing reporter than CLUSTER_THRESHOLD', () => {
    const ev: Evidence = { declared: null, peers: peers(0.9, true, CLUSTER_THRESHOLD - 1) };
    const d = decide(report('location'), ev, false);
    expect(d.outcome).toBe('FILE_INCIDENT');
  });

  it('honours a per-topic ceiling: 9 existing files, 10 existing deflects for Canvas', () => {
    // Canvas / web_portal uses 10 (clusterGate TOPIC_THRESHOLDS). decide() is
    // agnostic — it just reads the injected clusterThreshold.
    const below = decide(report('service_wide'), { declared: null, peers: peers(0.9, true, 9, 10) }, false);
    const at = decide(report('service_wide'), { declared: null, peers: peers(0.9, true, 10, 10) }, false);
    expect(below.outcome).toBe('FILE_INCIDENT');
    expect(at.outcome).toBe('MATCHED_CLUSTER');
  });

  it('honours the classroom AV boundary: 2 existing files, 3 existing deflects', () => {
    const below = decide(report('location'), { declared: null, peers: peers(0.9, true, 2, 3) }, false);
    const at = decide(report('location'), { declared: null, peers: peers(0.9, true, 3, 3) }, false);
    expect(below.outcome).toBe('FILE_INCIDENT');
    expect(at.outcome).toBe('MATCHED_CLUSTER');
  });

  it('files when the peer score is below threshold, however many reporters', () => {
    const ev: Evidence = { declared: null, peers: peers(THRESHOLD - 0.01, true, CLUSTER_THRESHOLD + 5) };
    const d = decide(report('location'), ev, false);
    expect(d.outcome).toBe('FILE_INCIDENT');
  });

  it('files when the peer cluster is outside the window', () => {
    const ev: Evidence = { declared: null, peers: peers(0.9, false, CLUSTER_THRESHOLD + 5) };
    const d = decide(report('location'), ev, false);
    expect(d.outcome).toBe('FILE_INCIDENT');
  });
});

describe('decide() — branch 4: file (no qualifying match)', () => {
  it('individual scope → FILE_REQUEST', () => {
    expect(decide(report('individual'), NO_EVIDENCE, false).outcome).toBe('FILE_REQUEST');
  });

  it('unknown scope → FILE_REQUEST (treated as individual)', () => {
    expect(decide(report('unknown'), NO_EVIDENCE, false).outcome).toBe('FILE_REQUEST');
  });

  it('location scope → FILE_INCIDENT', () => {
    expect(decide(report('location'), NO_EVIDENCE, false).outcome).toBe('FILE_INCIDENT');
  });

  it('service_wide scope → FILE_INCIDENT', () => {
    expect(decide(report('service_wide'), NO_EVIDENCE, false).outcome).toBe('FILE_INCIDENT');
  });
});

describe('decide() — result shape', () => {
  it('always returns a non-empty machine-readable reason', () => {
    const d = decide(report('individual'), NO_EVIDENCE, false);
    expect(typeof d.reason).toBe('string');
    expect(d.reason.length).toBeGreaterThan(0);
  });
});
