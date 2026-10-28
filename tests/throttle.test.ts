// safety/report_throttle.md — the required abuse control, not a stretch goal.
//
// Reported-symptom volume is this service's attack surface: one person with an
// assistant window can produce reports faster than any human reporter, and each
// is a potential ticket in ITS's queue and a potential vote toward a NOC alert.
//
// The limits themselves are UNSET and injected here. Nothing in src/ defaults
// them, and the last test in this file is what keeps that true.

import { beforeEach, describe, expect, it } from 'vitest';

import { InMemoryRateLimiter } from '../src/adapters/memory';
import { configureGate, resetGate } from '../src/clusterGate';
import type { ProblemReport } from '../src/contracts/types';
import { handleReport } from '../src/orchestrator';
import { configureThrottle, resetThrottle, throttleLimits } from '../src/throttleLimits';
import { harness, IDENTITY_REF, mutableClock, TEST_GATE } from './harness';

const LIMITS = { windowMinutes: 60, maxReportsPerIdentity: 3, maxDistinctServicesPerWindow: 4 } as const;

const MUIR_WIFI: ProblemReport = {
  service: 'wifi',
  scope: 'location',
  location: 'North Residence Hall',
  building: 'NORTH RESIDENCE HALL',
  room: '',
  symptom: 'intermittent',
  observedAt: '',
  verbatim: 'the wifi in North Residence Hall keeps dropping',
};

/** Distinct text per call, so the idempotency key never absorbs the report. */
const distinct = (n: number): ProblemReport => ({ ...MUIR_WIFI, verbatim: `${MUIR_WIFI.verbatim} (${n})` });

beforeEach(() => {
  resetGate();
  resetThrottle();
  configureGate(TEST_GATE);
  configureThrottle(LIMITS);
});

describe('the limit itself', () => {
  it('passes under the limit, passes the report that reaches it, blocks the next', async () => {
    const { clock } = mutableClock();
    const shared = harness(MUIR_WIFI, clock);
    const outcomes: string[] = [];

    for (let i = 0; i < LIMITS.maxReportsPerIdentity + 1; i++) {
      // Re-point the stubbed parser at a distinct report each time; everything
      // else (limiter, audit, adapters) is deliberately shared across the loop.
      const parser = { parse: async () => ({ report: distinct(i), source: 'keyword' as const }) };
      const h = { ...shared, deps: { ...shared.deps, parser } };
      const res = await handleReport(
        { text: distinct(i).verbatim, identityRef: IDENTITY_REF, canFollowUp: true },
        h.deps,
      );
      outcomes.push(res.outcome);
    }

    expect(outcomes.slice(0, LIMITS.maxReportsPerIdentity)).toEqual([
      'FILED_INCIDENT',
      'FILED_INCIDENT',
      'FILED_INCIDENT',
    ]);
    expect(outcomes[LIMITS.maxReportsPerIdentity]).toBe('THROTTLED');
  });

  it('a throttled report performs no search, files nothing, and publishes no event', async () => {
    const h = harness(MUIR_WIFI);
    const { hash } = await h.deps.identity.resolve(IDENTITY_REF);
    for (let i = 0; i < LIMITS.maxReportsPerIdentity; i++) await h.limiter.record(hash, MUIR_WIFI);

    const res = await handleReport(
      { text: MUIR_WIFI.verbatim, identityRef: IDENTITY_REF, canFollowUp: true },
      h.deps,
    );

    expect(res.outcome).toBe('THROTTLED');
    expect(h.audit.lines.some((l) => l.action === 'searched')).toBe(false);
    expect(h.tickets.filed).toHaveLength(0);
    // Otherwise throttling becomes a route to manufacturing an alert rather than
    // a defence against it (pattern_alert.md).
    expect(h.stream.events).toHaveLength(0);
    // Never a silent drop: a dropped report is indistinguishable from an outage
    // of this service.
    expect(h.audit.lines.some((l) => l.action === 'throttled')).toBe(true);
  });

  it('the reply carries a human path and a retry hint, never a fake success', async () => {
    const h = harness(MUIR_WIFI);
    const { hash } = await h.deps.identity.resolve(IDENTITY_REF);
    for (let i = 0; i < LIMITS.maxReportsPerIdentity; i++) await h.limiter.record(hash, MUIR_WIFI);

    const res = await handleReport(
      { text: MUIR_WIFI.verbatim, identityRef: IDENTITY_REF, canFollowUp: true },
      h.deps,
    );
    expect(res.reply).toContain('Service Desk');
    expect(res.reply).toMatch(/try again in about \d+ minute/);
    expect(res.ticket).toBeUndefined();
  });
});

describe('what does and does not consume budget', () => {
  it("an idempotent repeat returns the prior result and does NOT spend budget", async () => {
    const h = harness(MUIR_WIFI);
    const req = { text: MUIR_WIFI.verbatim, identityRef: IDENTITY_REF, canFollowUp: true };

    const first = await handleReport(req, h.deps);
    // Five more identical submissions — a flaky network retrying, not an abuser.
    for (let i = 0; i < 5; i++) {
      const again = await handleReport(req, h.deps);
      expect(again.outcome).toBe(first.outcome);
      expect(again.ticket?.ticketNumber).toBe(first.ticket?.ticketNumber);
    }

    // Exactly one ticket, and the budget was charged exactly once — charging
    // someone for their own retry is a bug that punishes flaky networks.
    expect(h.tickets.filed).toHaveLength(1);
    const { hash } = await h.deps.identity.resolve(IDENTITY_REF);
    expect((await h.limiter.check(hash)).allowed).toBe(true);
  });

  it('an override resubmission DOES consume budget', async () => {
    const { clock } = mutableClock();
    const shared = harness(MUIR_WIFI, clock);
    const { hash } = await shared.deps.identity.resolve(IDENTITY_REF);

    // Overrides bypass both the cluster gate and the idempotency key. If they also
    // bypassed the throttle, the escape hatch would be the flood vector.
    for (let i = 0; i < LIMITS.maxReportsPerIdentity; i++) {
      await handleReport(
        {
          text: MUIR_WIFI.verbatim,
          identityRef: IDENTITY_REF,
          canFollowUp: true,
          overrideMatchId: 'REQ300',
        },
        shared.deps,
      );
    }

    expect((await shared.limiter.check(hash)).allowed).toBe(false);
  });
});

describe('the window', () => {
  it('rolls over and restores budget — testable without waiting, because the clock is injected', async () => {
    const { clock, advanceMinutes } = mutableClock();
    const limiter = new InMemoryRateLimiter(clock);

    for (let i = 0; i < LIMITS.maxReportsPerIdentity; i++) await limiter.record('rh_x', MUIR_WIFI);
    expect((await limiter.check('rh_x')).allowed).toBe(false);

    advanceMinutes(LIMITS.windowMinutes + 1);
    expect((await limiter.check('rh_x')).allowed).toBe(true);
  });

  it('reports a retryAfter that lands inside the window', async () => {
    const { clock } = mutableClock();
    const limiter = new InMemoryRateLimiter(clock);
    for (let i = 0; i < LIMITS.maxReportsPerIdentity; i++) await limiter.record('rh_y', MUIR_WIFI);

    const { allowed, retryAfterSeconds } = await limiter.check('rh_y');
    expect(allowed).toBe(false);
    expect(retryAfterSeconds).toBeGreaterThan(0);
    expect(retryAfterSeconds).toBeLessThanOrEqual(LIMITS.windowMinutes * 60);
  });
});

describe('variety is not an evasion', () => {
  it('blocks once the distinct-service limit is reached inside the window', async () => {
    const { clock } = mutableClock();
    const limiter = new InMemoryRateLimiter(clock);
    // A flooder's cheapest evasion: five reports across five services look less
    // repetitive than five identical ones.
    configureThrottle({ windowMinutes: 60, maxReportsPerIdentity: 100, maxDistinctServicesPerWindow: 3 });

    for (const service of ['wifi', 'vpn', 'web_portal'] as const) {
      await limiter.record('rh_v', { ...MUIR_WIFI, service });
    }
    expect((await limiter.check('rh_v')).allowed).toBe(false);
  });
});

describe('the throttle limits are unset in source', () => {
  it('reading them before injection throws loudly rather than defaulting', () => {
    resetThrottle();
    expect(() => throttleLimits()).toThrow(/source ships no default/);
  });

  it('the limiter itself refuses to answer without injected limits', async () => {
    resetThrottle();
    const limiter = new InMemoryRateLimiter(() => new Date());
    await expect(limiter.check('rh_any')).rejects.toThrow(/not configured/);
  });
});
