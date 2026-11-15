// Priority policy — a deterministic table, never a model (docs/DECISIONS.md #2).
//
// Inputs are only: the service's tier from the policy document, the number of
// DISTINCT reporters on a parent incident, and whether a strict majority of them
// sounded frustrated. Frustration can raise the result by at most one level, so
// it can never be the main driver (polite reporters are not pushed down, angry
// ones gain at most one step).
//
// The priority is written once, when the parent incident is created. Every
// later raise is a recommendation a human applies: this service has no update
// permission in ServiceNow, by design.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import type { PriorityDecision } from './contracts/types';
import { SERVICES } from './vocab/catalog';

export type PolicyRule = {
  readonly id: string;
  readonly tier: number;
  readonly minDistinctReporters: number;
  /** ServiceNow scale: 1 Critical … 5 Planning. Lower number = more urgent. */
  readonly priority: number;
};

export type PriorityPolicy = {
  readonly name: string;
  readonly serviceTiers: Readonly<Record<string, number>>;
  readonly rules: readonly PolicyRule[];
};

/** A raise a human should apply to an open parent incident. Advice only. */
export type Recommendation = PriorityDecision & {
  /** The distinct-reporter count when this raise was first called for. */
  readonly distinctReporters: number;
};

/** The synthetic policy committed with the repo. Real policies live outside it. */
export const EXAMPLE_POLICY_PATH = fileURLToPath(new URL('../policy.example.yaml', import.meta.url));

/** Reads PRIORITY_POLICY_PATH, or the synthetic example when it is unset. Throws on an invalid file. */
export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): PriorityPolicy {
  return loadPolicy(env.PRIORITY_POLICY_PATH?.trim() || EXAMPLE_POLICY_PATH);
}

export function loadPolicy(path: string): PriorityPolicy {
  return validatePolicy(parse(readFileSync(path, 'utf8')));
}

/**
 * The policy file is edited by people, outside this repo, so it is untrusted
 * input: a bad file fails at startup with the reason, never mid-request.
 */
export function validatePolicy(raw: unknown): PriorityPolicy {
  const fail = (why: string): never => {
    throw new Error(`priority policy: ${why}`);
  };
  const isInt = (v: unknown, min: number, max: number): v is number =>
    Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

  if (typeof raw !== 'object' || raw === null) fail('not a YAML mapping');
  const doc = raw as Record<string, unknown>;
  if (typeof doc.name !== 'string' || doc.name === '') fail('name is required');
  if (typeof doc.service_tiers !== 'object' || doc.service_tiers === null) fail('service_tiers is required');
  if (!Array.isArray(doc.rules)) fail('rules must be a list');

  const tiers = doc.service_tiers as Record<string, unknown>;
  for (const service of SERVICES) {
    if (!isInt(tiers[service], 1, 9)) fail(`service ${service} needs an integer tier`);
  }

  const rules = (doc.rules as unknown[]).map((r, i): PolicyRule => {
    const rule = (typeof r === 'object' && r !== null ? r : {}) as Record<string, unknown>;
    if (typeof rule.id !== 'string' || rule.id === '') fail(`rule ${i} needs an id`);
    if (!isInt(rule.tier, 1, 9)) fail(`rule ${rule.id} needs an integer tier`);
    if (!isInt(rule.min_distinct_reporters, 1, 1_000_000)) fail(`rule ${rule.id} needs min_distinct_reporters >= 1`);
    if (!isInt(rule.priority, 1, 5)) fail(`rule ${rule.id} needs priority 1-5`);
    return {
      id: rule.id as string,
      tier: rule.tier as number,
      minDistinctReporters: rule.min_distinct_reporters as number,
      priority: rule.priority as number,
    };
  });

  if (new Set(rules.map((r) => r.id)).size !== rules.length) fail('rule ids must be unique');
  // Every tier in use needs a rule that applies from the first reporter, or a
  // new parent would have no priority to be created with.
  for (const tier of new Set(SERVICES.map((s) => tiers[s] as number))) {
    if (!rules.some((r) => r.tier === tier && r.minDistinctReporters === 1)) {
      fail(`tier ${tier} needs a rule with min_distinct_reporters: 1`);
    }
  }

  return { name: doc.name as string, serviceTiers: tiers as Record<string, number>, rules };
}

/**
 * The priority the table gives a parent incident right now, and the rule that
 * gave it. Pure: same inputs, same answer.
 */
export function priorityFor(
  policy: PriorityPolicy,
  service: string,
  distinctReporters: number,
  frustratedMajority: boolean,
): PriorityDecision {
  const tier = policy.serviceTiers[service];
  // Validation guarantees a min-1 rule for every tier, so this is never empty.
  const rule = policy.rules
    .filter((r) => r.tier === tier && r.minDistinctReporters <= distinctReporters)
    .reduce((best, r) => (r.minDistinctReporters > best.minDistinctReporters ? r : best));
  const raised = frustratedMajority && rule.priority > 1;
  return { priority: raised ? rule.priority - 1 : rule.priority, ruleId: rule.id, frustrationRaised: raised };
}

/**
 * After a report links to a parent: a new recommendation if the table now calls
 * for something more urgent than both the priority the parent was created with
 * and any recommendation already pending; otherwise null. At most one
 * recommendation is pending per parent — a further rise replaces it.
 */
export function raiseFor(
  policy: PriorityPolicy,
  parent: {
    readonly service: string;
    readonly priority: PriorityDecision;
    readonly recommendation: Recommendation | null;
    readonly reporters: ReadonlySet<string>;
    readonly frustrated: ReadonlySet<string>;
  },
): Recommendation | null {
  const distinctReporters = parent.reporters.size;
  const now = priorityFor(policy, parent.service, distinctReporters, parent.frustrated.size * 2 > distinctReporters);
  const current = parent.recommendation?.priority ?? parent.priority.priority;
  return now.priority < current ? { ...now, distinctReporters } : null;
}
