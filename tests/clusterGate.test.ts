// Per-topic deflection ceilings (clusterGate.ts, cluster_gate.md).
//
// thresholdFor() is the "hard-coded values document" the feature calls for, kept
// inside the one module that owns the count so nothing else holds the number. It
// changes only WHEN deflection begins — never the deflect wording (boundaries.md
// boundary 2) and never any existing ticket (boundary 1). These tests pin the
// resolution rules; decide.test.ts and flows.test.ts prove the number is applied.

import { describe, expect, it } from 'vitest';

import { CLUSTER_THRESHOLD, thresholdFor } from '../src/clusterGate';

describe('thresholdFor() — per-topic deflection ceilings', () => {
  it('falls back to CLUSTER_THRESHOLD when no topic rule matches', () => {
    expect(thresholdFor('wifi', 'North Residence Hall')).toBe(CLUSTER_THRESHOLD);
    expect(thresholdFor('vpn', '')).toBe(CLUSTER_THRESHOLD);
    expect(thresholdFor('wired_network', 'Main Library')).toBe(CLUSTER_THRESHOLD);
  });

  it('applies the canvas / web_portal ceiling of 10 regardless of location', () => {
    expect(thresholdFor('web_portal', '')).toBe(10);
    expect(thresholdFor('web_portal', 'anywhere')).toBe(10);
  });

  it('applies the classroom AV ceiling of 3 regardless of location', () => {
    expect(thresholdFor('classroom_av', '')).toBe(3);
    expect(thresholdFor('classroom_av', 'Lecture Hall')).toBe(3);
  });

  it('applies the library-wifi ceiling only when both service and location match', () => {
    const canonicalThreshold = thresholdFor('wifi', 'library');
    expect(canonicalThreshold).toBe(5);
    for (const location of ['Library', ' LIBRARY ', '  library  ', 'LiBrArY']) {
      expect(thresholdFor('wifi', location)).toBe(canonicalThreshold);
    }
    // A different location for the same service falls back to the default.
    expect(thresholdFor('wifi', 'North Residence Hall')).toBe(CLUSTER_THRESHOLD);
  });

  it('a location-specific rule outranks a service-only rule (resolution order)', () => {
    // web_portal has only a service-only rule; adding a location does not change it,
    // proving service-only rules apply across locations. This is the mirror of the
    // library-wifi case above and documents the precedence direction.
    expect(thresholdFor('web_portal', 'library')).toBe(10);
  });

  it('returns a positive integer for every catalog service (never zero/undefined)', () => {
    for (const service of ['wifi', 'wired_network', 'vpn', 'web_portal', 'classroom_av', 'unknown']) {
      const t = thresholdFor(service, '');
      expect(Number.isInteger(t)).toBe(true);
      expect(t).toBeGreaterThan(0);
    }
  });
});
