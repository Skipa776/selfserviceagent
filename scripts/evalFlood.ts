// `npm run eval:flood` — runs the scripted flood-control scenarios
// (tests/floodScenarios.ts) and prints the numbers recorded in docs/RESULTS.md.
// Offline and deterministic: keyword parser, in-memory adapters, a fixed clock,
// the synthetic example policy. Everything measured here is SYNTHETIC.

import { runScenario, SCENARIOS } from '../tests/floodScenarios';

const results = await Promise.all(SCENARIOS.map(runScenario));

const columns = ['reports', 'naiveCreates', 'creates', 'duplicateCreatesAvoided', 'falseMerges', 'missedMerges'] as const;
// The same headers as docs/RESULTS.md, so the table pastes in unchanged.
const HEADERS = { reports: 'reports', naiveCreates: 'naive creates', creates: 'creates', duplicateCreatesAvoided: 'duplicate creates avoided', falseMerges: 'false merges', missedMerges: 'missed merges' };
process.stdout.write(`| scenario | ${columns.map((c) => HEADERS[c]).join(' | ')} |\n|---|${columns.map(() => '---:').join('|')}|\n`);
for (const r of results) process.stdout.write(`| ${r.name} | ${columns.map((c) => r[c]).join(' | ')} |\n`);
const total = (c: (typeof columns)[number]): number => results.reduce((sum, r) => sum + r[c], 0);
process.stdout.write(`| **total** | ${columns.map((c) => `**${total(c)}**`).join(' | ')} |\n`);
