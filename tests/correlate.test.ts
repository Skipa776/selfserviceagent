// The correlation engine: grouping rules pinned at their edges (M3 council, checklist 3).

import { describe, expect, it } from 'vitest';

import { correlate, type Signal } from '../src/correlate';

const MIN = 60_000;
const s = (key: string, source: string, minute: number, weight = 1): Signal => ({ key, source, time: minute * MIN, weight });

describe('correlate', () => {
  it('groups by key and counts each source once, at its highest weight', () => {
    const [group] = correlate([s('a', 'x', 0, 1), s('a', 'x', 1, 3), s('a', 'y', 2, 2)], 60 * MIN);
    expect(group).toMatchObject({ key: 'a', sources: ['x', 'y'], score: 5, members: [0, 1, 2], firstTime: 0, lastTime: 2 * MIN });
  });

  it('never mixes keys', () => {
    expect(correlate([s('a', 'x', 0), s('b', 'y', 0)], 60 * MIN).map((g) => g.key)).toEqual(['a', 'b']);
  });

  it('includes a signal exactly one window after the first, and opens a new group just past it', () => {
    const groups = correlate([s('a', 'x', 0), s('a', 'y', 60), s('a', 'z', 60.001)], 60 * MIN);
    expect(groups.map((g) => g.members)).toEqual([[0, 1], [2]]);
  });

  it('does not slide: a steady stream becomes back-to-back groups', () => {
    const groups = correlate([0, 40, 80, 120].map((m, i) => s('a', `src${i}`, m)), 60 * MIN);
    expect(groups.map((g) => g.members)).toEqual([[0, 1], [2, 3]]);
  });

  it('groups the same signals with the same scores for any input order', () => {
    const signals = [s('a', 'x', 5), s('a', 'y', 1), s('a', 'z', 1), s('b', 'x', 3), s('a', 'w', 70)];
    const shuffled = [signals[3], signals[4], signals[0], signals[2], signals[1]];
    const shape = (input: Signal[]) =>
      correlate(input, 60 * MIN)
        .map((g) => ({ key: g.key, score: g.score, members: g.members.map((i) => input[i].source).sort() }))
        .sort((a, b) => a.key.localeCompare(b.key) || a.members.join().localeCompare(b.members.join()));
    expect(shape(shuffled)).toEqual(shape(signals));
  });

  it('lists members with exactly the same time in input order', () => {
    const signals = [s('a', 'x', 5), s('a', 'y', 1), s('a', 'z', 1)];
    expect(correlate(signals, 60 * MIN)[0].members).toEqual([1, 2, 0]);
  });

  it('returns nothing for nothing', () => {
    expect(correlate([], 60 * MIN)).toEqual([]);
  });
});
