// The correlation engine (Milestone 3, docs/DECISIONS.md #4).
//
// It knows nothing about tickets, alerts, buildings or detectors. It sees only
// signals — {key, source, time, weight} — and answers one question: which
// signals belong together? Adapters own every bit of meaning: what the key is,
// who counts as a source, what a signal weighs, and what score is enough to
// matter. Today two adapters use it: src/patternDetector.ts (report events) and
// src/alertAdapter.ts (security alerts).
//
// Pure: no clock, no state, no I/O. Shuffling the input never changes which
// signals are grouped together or any score; only members with exactly the same
// time are listed in input order.

export type Signal = {
  /** What must match for two signals to belong together. */
  readonly key: string;
  /** Who produced it. A source counts once per group, however many signals it sends. */
  readonly source: string;
  /** Epoch milliseconds, taken from the signal itself, never from a clock. */
  readonly time: number;
  /** How much one source's signal counts. A source contributes its highest weight. */
  readonly weight: number;
};

export type Group = {
  readonly key: string;
  readonly firstTime: number;
  readonly lastTime: number;
  /** Distinct sources, in the order they first appeared. */
  readonly sources: readonly string[];
  /** Sum over distinct sources of each source's highest weight. */
  readonly score: number;
  /** Indexes into the input array, in time order (ties keep input order). */
  readonly members: readonly number[];
};

/**
 * Fixed windows per key: a group starts at its first signal and takes every
 * later signal of the same key at most `windowMs` after that first one; the
 * next signal opens a new group. Windows do not slide, so one long burst
 * becomes back-to-back groups rather than one group that never closes.
 */
export function correlate(signals: readonly Signal[], windowMs: number): Group[] {
  // Sort by time, then by input index, so ties and input order cannot change the result.
  const order = signals.map((_, i) => i).sort((a, b) => signals[a].time - signals[b].time || a - b);

  type Building = { key: string; firstTime: number; lastTime: number; best: Map<string, number>; members: number[] };
  const open = new Map<string, Building>();
  const groups: Building[] = [];

  for (const i of order) {
    const s = signals[i];
    let group = open.get(s.key);
    if (group === undefined || s.time - group.firstTime > windowMs) {
      group = { key: s.key, firstTime: s.time, lastTime: s.time, best: new Map(), members: [] };
      open.set(s.key, group);
      groups.push(group);
    }
    group.members.push(i);
    group.lastTime = s.time;
    group.best.set(s.source, Math.max(group.best.get(s.source) ?? -Infinity, s.weight));
  }

  return groups.map((g) => ({
    key: g.key,
    firstTime: g.firstTime,
    lastTime: g.lastTime,
    sources: [...g.best.keys()],
    score: [...g.best.values()].reduce((sum, w) => sum + w, 0),
    members: g.members,
  }));
}
