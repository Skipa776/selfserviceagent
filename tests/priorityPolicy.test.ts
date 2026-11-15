// The priority table and its one soft input, frustration (docs/DECISIONS.md #2).

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';

import { isFrustrated } from '../src/frustration';
import { EXAMPLE_POLICY_PATH, loadPolicy, priorityFor, raiseFor, validatePolicy } from '../src/priorityPolicy';
import { SERVICES } from '../src/vocab/catalog';

const policy = loadPolicy(EXAMPLE_POLICY_PATH);
const exampleDoc = (): Record<string, unknown> => parse(readFileSync(EXAMPLE_POLICY_PATH, 'utf8')) as Record<string, unknown>;

describe('loading a policy file', () => {
  it('loads the synthetic example, with a tier for every catalog service', () => {
    expect(policy.name).toBe('synthetic-example-v1');
    for (const service of SERVICES) expect(policy.serviceTiers[service]).toBeGreaterThan(0);
  });

  it('rejects a file that would leave a parent without a priority', () => {
    const doc = exampleDoc();
    const missingTier = { ...doc, service_tiers: { ...(doc.service_tiers as object), vpn: undefined } };
    expect(() => validatePolicy(missingTier)).toThrow(/service vpn needs an integer tier/);

    const noFirstRule = { ...doc, rules: (doc.rules as { id: string }[]).filter((r) => r.id !== 't2-reporters-1') };
    expect(() => validatePolicy(noFirstRule)).toThrow(/tier 2 needs a rule with min_distinct_reporters: 1/);
  });

  it('rejects out-of-range priorities and duplicate rule ids', () => {
    const doc = exampleDoc();
    const rules = doc.rules as Record<string, unknown>[];
    expect(() => validatePolicy({ ...doc, rules: [{ ...rules[0], priority: 0 }, ...rules.slice(1)] })).toThrow(/priority 1-5/);
    expect(() => validatePolicy({ ...doc, rules: [...rules, rules[0]] })).toThrow(/unique/);
    expect(() => validatePolicy('not a mapping')).toThrow(/YAML mapping/);
  });
});

describe('priorityFor', () => {
  it('uses the rule with the highest reporter count reached in the service tier', () => {
    expect(priorityFor(policy, 'wifi', 1, false)).toEqual({ priority: 4, ruleId: 't2-reporters-1', frustrationRaised: false });
    expect(priorityFor(policy, 'wifi', 4, false).ruleId).toBe('t2-reporters-1');
    expect(priorityFor(policy, 'wifi', 5, false).ruleId).toBe('t2-reporters-5');
    expect(priorityFor(policy, 'wifi', 500, false)).toEqual({ priority: 2, ruleId: 't2-reporters-15', frustrationRaised: false });
  });

  it('lets frustration raise one level, never more, never past P1', () => {
    expect(priorityFor(policy, 'wifi', 1, true)).toEqual({ priority: 3, ruleId: 't2-reporters-1', frustrationRaised: true });
    expect(priorityFor(policy, 'web_portal', 20, true)).toEqual({ priority: 1, ruleId: 't1-reporters-20', frustrationRaised: false });
  });

  it('keeps one frustrated first reporter away from P1 in the example policy', () => {
    for (const service of SERVICES) expect(priorityFor(policy, service, 1, true).priority).toBeGreaterThanOrEqual(2);
  });
});

describe('raiseFor — the one pending recommendation', () => {
  const parent = (reporters: number, frustrated: number, recommendation: ReturnType<typeof raiseFor> = null) => ({
    service: 'wifi',
    priority: priorityFor(policy, 'wifi', 1, false),
    recommendation,
    reporters: new Set([...Array(reporters).keys()].map(String)),
    frustrated: new Set([...Array(frustrated).keys()].map(String)),
  });

  it('recommends only when the table now asks for more than the parent has', () => {
    expect(raiseFor(policy, parent(4, 0))).toBeNull();
    expect(raiseFor(policy, parent(5, 0))).toMatchObject({ priority: 3, ruleId: 't2-reporters-5', distinctReporters: 5 });
  });

  it('does not repeat a recommendation already pending, and replaces it on a further rise', () => {
    const pending = raiseFor(policy, parent(5, 0));
    expect(raiseFor(policy, parent(6, 0, pending))).toBeNull();
    expect(raiseFor(policy, parent(15, 0, pending))).toMatchObject({ priority: 2, ruleId: 't2-reporters-15' });
  });

  it('counts frustration only from a strict majority of distinct reporters', () => {
    expect(raiseFor(policy, parent(4, 2))).toBeNull(); // half is not a majority
    expect(raiseFor(policy, parent(4, 3))).toMatchObject({ priority: 3, ruleId: 't2-reporters-1', frustrationRaised: true });
  });
});

describe('isFrustrated (unvalidated placeholder for the M2 score model)', () => {
  it('flags repetition, fed-up wording, repeated exclamation and shouting', () => {
    for (const text of [
      'wifi is down again',
      'STILL no wifi in the library',
      'This is the third time this week',
      'Wifi is dead!!',
      'NOTHING works in Lecture Hall',
    ]) expect(isFrustrated(text), text).toBe(true);
  });

  it('leaves plain reports and acronyms alone', () => {
    for (const text of [
      'wifi in North Residence Hall keeps dropping',
      'VPN keeps asking me to sign in',
      'The projector will not turn on!',
      'the gains against the outage were small',
    ]) expect(isFrustrated(text), text).toBe(false);
  });
});
