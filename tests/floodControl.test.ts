// Milestone 1 acceptance: flood control (docs/DECISIONS.md #1 and #2).
//
// A burst of same-problem reports from distinct reporters must produce ONE
// parent INC in ServiceNow, nothing else created, every reporter counted on the
// local ledger, and at most one pending priority recommendation that names the
// policy rule it came from.

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SnowConfig } from '../src/adapters/servicenow';
import { buildStage1, buildStage2, identitySalt } from '../src/composition';
import type { ReportResponse } from '../src/contracts/api';
import { handleReport } from '../src/orchestrator';
import { EXAMPLE_POLICY_PATH, loadPolicy } from '../src/priorityPolicy';
import { CORPUS_NOW } from './corpus';
import { runScenario, SCENARIOS } from './floodScenarios';
import { mutableClock } from './harness';

const NRH_WIFI = 'wifi in North Residence Hall keeps dropping';
/** Every fifth report sounds fed up: a minority, so frustration must not raise anything. */
const burstText = (i: number): string => (i % 5 === 4 ? `${NRH_WIFI} again` : NRH_WIFI);

async function burst(deps: Parameters<typeof handleReport>[1], n = 30): Promise<ReportResponse[]> {
  // Fired concurrently on purpose: the ledger must serialize per problem, or
  // several reports would each see "no parent yet" and create one.
  return Promise.all(
    [...Array(n).keys()].map((i) =>
      handleReport({ text: burstText(i), identityRef: `burst-reporter-${i}`, canFollowUp: true }, deps),
    ),
  );
}

describe('30 same-problem reports from 30 distinct reporters', () => {
  it('create exactly one parent INC, link the other 29, and count all 30 locally', async () => {
    const system = buildStage1({ clock: () => new Date(CORPUS_NOW) });
    const responses = await burst(system.deps);

    expect(responses.filter((r) => r.outcome === 'FILED_INCIDENT')).toHaveLength(1);
    expect(responses.filter((r) => r.outcome === 'MATCHED_CLUSTER')).toHaveLength(29);
    expect(system.tickets.filed).toHaveLength(1);
    expect(system.tickets.filed[0].ticketClass).toBe('INC');

    const [parent] = system.ledger.all();
    expect(system.ledger.all()).toHaveLength(1);
    expect(parent.reporters.size).toBe(30);
    // Every child points at the parent, nothing else.
    for (const r of responses.filter((r) => r.outcome === 'MATCHED_CLUSTER')) {
      expect(r.cluster?.ticketIds).toEqual([parent.ticketNumber]);
    }
  });

  it('set the parent priority once, from the policy, and leave ONE recommendation citing its rule', async () => {
    const system = buildStage1({ clock: () => new Date(CORPUS_NOW) });
    await burst(system.deps);
    const [parent] = system.ledger.all();
    const ruleIds = loadPolicy(EXAMPLE_POLICY_PATH).rules.map((r) => r.id);

    // wifi is tier 2 in the example policy: P4 for one reporter.
    expect(system.tickets.filed[0].priority).toEqual({ priority: 4, ruleId: 't2-reporters-1', frustrationRaised: false });
    expect(parent.priority).toEqual(system.tickets.filed[0].priority);

    // The 15th reporter reached the 15-reporter rule: recommend P2, recorded
    // with the count at that moment. Frustrated reporters are a minority (6 of
    // 30), so no extra level.
    expect(parent.recommendation).toMatchObject({ priority: 2, ruleId: 't2-reporters-15', frustrationRaised: false, distinctReporters: 15 });
    expect(ruleIds).toContain(parent.recommendation?.ruleId);

    // The 5-reporter rule fired first and was replaced, not stacked.
    const recommended = system.audit.lines.filter((l) => l.action === 'recommended');
    expect(recommended.map((l) => l.policyRuleId)).toEqual(['t2-reporters-5', 't2-reporters-15']);
  });

  it('against the real ServiceNow adapter: one POST, and no PATCH, PUT or DELETE', async () => {
    vi.stubEnv('REPORTER_HASH_SALT', 'test-salt');
    const pdi = fakeServiceNow();
    const system = buildStage2({
      createMessage: null,
      snow: { config: SNOW_CONFIG, fetchImpl: pdi.fetch },
      clock: () => new Date(CORPUS_NOW),
    });

    await burst(system.deps);

    const methods = pdi.requests.map((r) => r.method);
    expect(methods.filter((m) => m === 'POST')).toHaveLength(1);
    expect(methods.filter((m) => m !== 'GET' && m !== 'POST')).toEqual([]);
    // The parent's priority reaches ServiceNow as impact + urgency (P4 → 2/3).
    expect(pdi.created[0]).toMatchObject({ impact: '2', urgency: '3' });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the ledger counts people, not messages', () => {
  it('a reporter who reports twice, in different words, counts once', async () => {
    const system = buildStage1({ clock: () => new Date(CORPUS_NOW) });
    await handleReport({ text: NRH_WIFI, identityRef: 'alex', canFollowUp: true }, system.deps);
    await handleReport({ text: 'North Residence Hall wireless keeps cutting out', identityRef: 'alex', canFollowUp: true }, system.deps);
    await handleReport({ text: NRH_WIFI, identityRef: 'sam', canFollowUp: true }, system.deps);

    expect(system.tickets.filed).toHaveLength(1);
    expect(system.ledger.all()[0].reporters.size).toBe(2);
  });
});

describe('failure and escape paths', () => {
  it('a parent create with an unknown outcome blocks every create for that problem until the window passes', async () => {
    const { clock, advanceMinutes } = mutableClock();
    const system = buildStage1({ clock });
    system.tickets.failTimes = 1;
    system.tickets.ambiguous = true;

    const first = await handleReport({ text: NRH_WIFI, identityRef: 'r1', canFollowUp: true }, system.deps);
    const second = await handleReport({ text: NRH_WIFI, identityRef: 'r2', canFollowUp: true }, system.deps);
    expect([first.outcome, second.outcome]).toEqual(['UNAVAILABLE', 'UNAVAILABLE']);
    expect(system.tickets.filed).toHaveLength(0);

    advanceMinutes(121); // past the 120-minute demo window
    const later = await handleReport({ text: NRH_WIFI, identityRef: 'r3', canFollowUp: true }, system.deps);
    expect(later.outcome).toBe('FILED_INCIDENT');
  });

  it('an override files separately and leaves the parent untouched', async () => {
    const system = buildStage1({ clock: () => new Date(CORPUS_NOW) });
    const filed = await handleReport({ text: NRH_WIFI, identityRef: 'r1', canFollowUp: true }, system.deps);
    const linked = await handleReport({ text: NRH_WIFI, identityRef: 'r2', canFollowUp: true }, system.deps);
    const override = await handleReport(
      { text: NRH_WIFI, identityRef: 'r2', canFollowUp: true, overrideMatchId: linked.override?.matchId },
      system.deps,
    );

    expect(override.outcome).toBe('FILED_INCIDENT');
    expect(system.tickets.filed).toHaveLength(2);
    // Still one parent: the first INC, with the same two reporters.
    const [parent] = system.ledger.all();
    expect(system.ledger.all()).toHaveLength(1);
    expect(parent.ticketNumber).toBe(filed.ticket?.ticketNumber);
    expect(parent.reporters.size).toBe(2);
  });
});

describe('scripted scenarios (tests/floodScenarios.ts)', () => {
  it('merge nothing that should stay apart', async () => {
    for (const scenario of SCENARIOS) {
      const result = await runScenario(scenario);
      expect(result.falseMerges, scenario.name).toBe(0);
    }
  });

  it('create one INC per problem, except when an outage outlasts the fixed window', async () => {
    const byName = Object.fromEntries(await Promise.all(SCENARIOS.map(async (s) => [s.name, await runScenario(s)])));
    expect(byName['one building, 30 reporters']).toMatchObject({ creates: 1, missedMerges: 0 });
    expect(byName['same service, two buildings, interleaved']).toMatchObject({ creates: 2, missedMerges: 0 });
    expect(byName['same building, two services']).toMatchObject({ creates: 2, missedMerges: 0 });
    expect(byName['classroom AV, two rooms in one building']).toMatchObject({ creates: 2, missedMerges: 0 });
    // 1 INC for the building, 5 personal requests (never merged).
    expect(byName['personal reports inside a building flood']).toMatchObject({ creates: 6, missedMerges: 0 });
    expect(byName['campus-wide VPN outage']).toMatchObject({ creates: 1, missedMerges: 0 });
    expect(byName['one outage outlasting the link window']).toMatchObject({ creates: 2, missedMerges: 1 });
  });
});

describe('the identity salt comes from the environment', () => {
  it('uses REPORTER_HASH_SALT when set', () => {
    expect(identitySalt({ REPORTER_HASH_SALT: 'from-env' }, true)).toBe('from-env');
  });

  it('refuses to start against ServiceNow without one', () => {
    expect(() => identitySalt({}, true)).toThrow(/REPORTER_HASH_SALT/);
  });

  it('falls back to a random per-process salt for in-memory runs', () => {
    const a = identitySalt({}, false);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(identitySalt({}, false)).not.toBe(a);
  });
});

// ── A fake ServiceNow Table API: remembers what was created, lists it back ────

const SNOW_CONFIG: SnowConfig = {
  instanceUrl: 'https://dev-synthetic.service-now.com',
  user: 'synthetic',
  password: 'synthetic',
  incidentTable: 'incident',
  requestTable: 'sc_request',
  timeoutMs: 1000,
  readScope: 'service_owned',
};

function fakeServiceNow(): {
  fetch: typeof globalThis.fetch;
  requests: { method: string; url: string }[];
  created: Record<string, string>[];
} {
  const requests: { method: string; url: string }[] = [];
  const created: Record<string, string>[] = [];
  const fetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    requests.push({ method, url });
    if (method === 'POST') {
      const record = JSON.parse(String(init?.body)) as Record<string, string>;
      const number = `INC${String(created.length + 1).padStart(7, '0')}`;
      created.push({ ...record, number, sys_id: `sys${created.length + 1}`, opened_at: '2026-07-28 12:00:00', active: 'true' });
      return new Response(JSON.stringify({ result: { number, sys_id: `sys${created.length}` } }), { status: 201 });
    }
    const table = url.includes('/incident?') ? 'incident' : 'sc_request';
    return new Response(JSON.stringify({ result: table === 'incident' ? created : [] }), { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetch, requests, created };
}
