# Results

**Everything here is synthetic.** The reports, the corpus, the scenarios and
the priority policy were written for this project. Nothing here says anything
about real campus traffic, and the frustration signal has not been validated
against real people.

Every number below was measured, with the command that reproduces it. A number
that was not measured is listed as not measured.

## Measurement context

| | |
| --- | --- |
| Code | commit `6308c74` (branch `claude/kind-dirac-sx9ti2`) |
| Who | Claude Code cloud session, 2026-11-15 |
| Hardware | 4 vCPU Intel Xeon @ 2.10 GHz, 15 GiB RAM, Linux 6.18 |
| Runtime | Node 24.22.3, npm 10.9.9, `@anthropic-ai/sdk` 1.8.0, vitest 4.1.11 |
| Randomness | None that affects a number below: fixed clocks, keyword parser, in-memory adapters. The reporter-hash salt is random per process, but only equality of hashes matters. |

## Milestone 1 acceptance

| Requirement | Result | Where |
| --- | --- | --- |
| 30 same-type reports, 30 distinct reporters → exactly 1 parent INC create, 0 further creates | **1 create, 29 links** (fired concurrently) | `tests/floodControl.test.ts` |
| Local ledger count of 30 | **30** distinct reporter hashes on the parent | same |
| One priority recommendation citing its policy rule | **1 pending**: raise P4 → P2, rule `t2-reporters-15` (set at the 15th reporter). The `t2-reporters-5` recommendation fired first and was replaced. | same |
| ServiceNow adapter has no update method | asserted by `tests/servicenow.test.ts` (method list) and by running the burst through the real adapter over a fake Table API: **1 POST, 0 PATCH/PUT/DELETE** | `tests/servicenow.test.ts`, `tests/floodControl.test.ts` |
| `llmParser` on the Anthropic SDK, forced tool, `claude-haiku-5-5` | done; model id **confirmed** by the Models API on 2026-11-20: `claude-haiku-5-5` ("Claude Haiku 5.5") | `src/parser/llmParser.ts`, `npm run record:haiku` |
| Tests offline against recorded Haiku 5.5 responses | done: **26 real recorded exchanges** (29 API calls), replayed offline | `tests/fixtures/haiku-5-5.json` (`"recorded": true`) |
| Keyword fallback with no key | yes: the parser is not built without `ANTHROPIC_API_KEY`, and it falls back on any API failure | `tests/llmParser.test.ts` |
| `npm test`, `npm run build`, `npm run lint` offline | **477 tests pass** in 34 files (3.0 s); build and lint clean | commands below |

```bash
npm test
```

```bash
npm run build
```

```bash
npm run lint
```

## Flood control on scripted scenarios

Command (offline, deterministic):

```bash
npm run eval:flood
```

Baseline: "naive creates" is one ticket per report, what a plain form would
do. A false merge is a report linked to a parent opened for a different
problem. A missed merge is a second INC for a problem that already had one.

| scenario | reports | naive creates | creates | duplicate creates avoided | false merges | missed merges |
|---|---:|---:|---:|---:|---:|---:|
| one building, 30 reporters | 30 | 30 | 1 | 29 | 0 | 0 |
| same service, two buildings, interleaved | 20 | 20 | 2 | 18 | 0 | 0 |
| same building, two services | 20 | 20 | 2 | 18 | 0 | 0 |
| classroom AV, two rooms in one building | 12 | 12 | 2 | 10 | 0 | 0 |
| personal reports inside a building flood | 15 | 15 | 6 | 9 | 0 | 0 |
| campus-wide VPN outage | 15 | 15 | 1 | 14 | 0 | 0 |
| one outage outlasting the link window | 20 | 20 | 2 | 18 | 0 | **1** |
| **total** | **132** | **132** | **16** | **116** | **0** | **1** |

How to read this honestly:

- **The 0 false merges is a weak claim.** The same author wrote the scenarios and the correlation key, and every report goes through the keyword parser with clean phrasing. They check that the key separates what it is designed to separate (building, service, AV room, personal scope). They do not test parser mistakes, such as a report filed under the wrong building, which would merge wrongly.
- **The 1 missed merge is a real, designed-in limit** (DECISIONS.md C3): the link window is fixed at 120 demo minutes from the parent's creation, so an outage that outlasts it gets a second INC.
- "Personal reports inside a building flood": the 5 personal reports each file their own request (REQ) and are never merged. That is intended.

## Parser accuracy

| Parser | Set | Fields correct | Rows exact | Groups consistent | Command |
| --- | --- | ---: | ---: | ---: | --- |
| Keyword (baseline) | synthetic corpus, 26 rows (`tests/corpus.ts`) | 137/156 (87.8%) | 13/26 | 10/16 | `npm run eval:llm` |
| Claude Haiku 5.5 (run 1 of 3) | synthetic corpus, 26 rows | 150/156 (96.2%) | 20/26 | 12/16 | `LLM_EVAL_RUNS=3 npm run eval:llm` with `ANTHROPIC_API_KEY` |
| Keyword and Haiku 5.5 | hand-written set | **not measured**: the set is still a placeholder | | | `npm run eval:llm -- data/handwritten/reports.jsonl` |

The keyword parser's misses are mostly `symptom: unknown` and a few scopes it
deliberately leaves `unknown` (it is meant to be visibly imperfect). The
per-row misses are printed by the command.

Haiku 5.5 details (measured 2026-11-20, cloud session, same hardware, prompt and
corpus as commit `5a93463`, SDK 1.8.0):

- Across 3 runs × 26 rows = 78 parses: **1 keyword fallback**, **5 repairs**, and the outputs are **not identical across runs** (no sampling control on Haiku 5.5).
- **5 "unsafe" errors** in run 1 (scope, building, room or grouping wrong). Five of the six misses are `scope: unknown` where a building was named and `location` was expected. That is conservative: `unknown` scope leads to a follow-up question, not a wrong ticket. The sixth labels "my printer is out of toner" `equipment_unavailable` (expected `unknown`).
- The one fallback in the recording: for "Wired network in the Hillside Academic Building is very sluggish", Haiku returned the canonical location with an **empty building code**, twice, so validation failed and the keyword parser answered. The building follows deterministically from the location; see DECISIONS.md M2-C12.
- Recording cost: 29 calls, 51,942 input and 5,038 output tokens (about 1,790 input tokens per call, almost all of it the system prompt and tool schema).

## Other checks (not part of `npm test`)

| Check | Result | Note |
| --- | --- | --- |
| `npm run demo` | runs; shows 1 parent per problem, links, ledger and recommendations | narrative updated for flood control |
| `npm run demo:analyst:e2e` | 10 passed, 0 failed | only when no server from an earlier run is still alive (see LEARNINGS.md) |
| `npm run web:e2e` | **17 passed, 1 failed** | `presentation app explicitly enables synthetic reporter rotation` fails identically on the original base commit `54ba292`; not caused by M1. Queued as a separate task. |

## Re-recording

`npm run record:haiku` (needs `ANTHROPIC_API_KEY`) re-confirms the model id and
rewrites `tests/fixtures/haiku-5-5.json`. The replay test then pins the parser to
those responses. Re-record after any change to the system prompt or tool schema.
