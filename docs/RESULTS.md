# Results

**Everything here is synthetic or public.** The reports, the corpus, the training
text, the scenarios and the priority policy were written for this project (some by
Claude Haiku 5.5, labelled as such). The security alerts come from public recorded
attack simulations (OTRF, MIT) matched by public Sigma rules (SigmaHQ, Detection Rule
License 1.1). Nothing here says anything about real campus traffic, and the
frustration signal has not been validated against real people.

Every number below was measured, with the command that reproduces it. A number that
was not measured is listed as not measured. Failures and negative results are kept.

## Measurement context

| | |
| --- | --- |
| Who | Claude Code cloud session (not Josh's Mac) |
| Hardware | 4 vCPU Intel Xeon @ 2.10 GHz, 15 GiB RAM, Linux 6.18, no GPU |
| Runtime | Node 24.22.3, npm 10.9.9, `@anthropic-ai/sdk` 1.8.0, vitest 4.1.11; Python 3.13.18, scikit-learn 1.9.1, numpy 2.5.5, scipy 1.18.1 |
| Milestone 1 numbers | commit `6308c74`, 2026-11-15 (Haiku rows: 2026-11-20, see below) |
| Milestone 2 numbers | commit `7473102`, 2026-11-20; training data sha256 `7fe9042b8d99…` (full value in `models/weights.json`) |
| Milestone 3 numbers | commit `e11d434`, 2026-11-20 |
| Review round 4 | the 12 code branches of DECISIONS.md R4 merged together locally, 2026-11-20; every offline number below re-measured on that merge and unchanged unless marked |
| Randomness | Seeds fixed (`20261120`) for the templated data and training. Haiku 5.5 accepts no sampling setting, so every live Haiku number is from several runs. The reporter-hash salt is random per process; only equality of hashes matters. |

## Test suite

| | Result |
| --- | --- |
| `npm test` (offline, no key, no Python) | **540 tests pass** in 40 files (about 4 s), on Node 22.23.4 and on Node 24.22.3 (round 4 merge; 525 in 39 files before it) |
| `npm run build`, `npm run lint` | clean |

```bash
npm test
```

## Milestone 1: flood control and the Haiku parser

### Acceptance

| Requirement | Result | Where |
| --- | --- | --- |
| 30 same-type reports, 30 distinct reporters → exactly 1 parent INC create, 0 further creates | **1 create, 29 links** (fired concurrently) | `tests/floodControl.test.ts` |
| Local ledger count of 30 | **30** distinct reporter hashes on the parent | same |
| One priority recommendation citing its policy rule | **1 pending**: raise P4 → P2, rule `t2-reporters-15` (set at the 15th reporter); the `t2-reporters-5` one fired first and was replaced | same |
| ServiceNow adapter has no update method | method list asserted; the burst through the real adapter over a fake Table API sends **1 POST, 0 PATCH/PUT/DELETE** | `tests/servicenow.test.ts`, `tests/floodControl.test.ts` |
| `llmParser` on the Anthropic SDK, forced tool | model id **confirmed** by the Models API (2026-11-20, twice): `claude-haiku-5-5`, "Claude Haiku 5.5" | `npm run record:haiku` |
| Tests offline against recorded Haiku 5.5 responses | **26 real recorded exchanges**, replayed offline | `tests/fixtures/haiku-5-5.json` |
| Keyword fallback with no key | yes | `tests/llmParser.test.ts` |

### Flood control on scripted scenarios

```bash
npm run eval:flood
```

"Naive creates" is one ticket per report, what a plain form would do. A false merge
is a report linked to a parent opened for a different problem; a missed merge is a
second INC for a problem that already had one.

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

- **The 0 false merges is a weak claim.** The same author wrote the scenarios and the key, and every report goes through the keyword parser with clean phrasing. They test that the key separates what it is designed to separate, not parser mistakes.
- **The 1 missed merge is a designed-in limit** (DECISIONS.md C3): the link window is fixed at 120 demo minutes from the parent's creation.

## Parsers on the development set (26 rows)

The 26 rows of `tests/corpus.ts` are a **development set**, not a test set: the
keyword parser and the Haiku prompt were tuned on them, and the training templates
were written by someone who had read them (DECISIONS.md M2-Q8). They support counts,
not rates; one row is 3.8 points.

```bash
npm run eval:router
```

With `ANTHROPIC_API_KEY` set for the Haiku rows (each Haiku arm run 3 times):

| Parser | Fields correct (of 156) | Rows exact (of 26) | Reports sent to Haiku |
| --- | ---: | ---: | ---: |
| keyword only | 137 | 13 | 0 |
| router: specialist, then keyword (offline) | 142 | 16 | 0 |
| Haiku 5.5 only, 3 runs | 149, 149, 149 | 19, 19, 19 | 26 |
| router: specialist, then Haiku 5.5, 3 runs | mean 152.3 (152–153) | 22, 22, 23 | 15 |
| *Round 4 re-run on the merged branches:* Haiku 5.5 only, 3 runs | mean 149.3 (149–150) | 19, 19, 20 | 26 |
| *Round 4 re-run:* router, specialist then Haiku 5.5, 3 runs | mean 152.0 (152–152) | 22, 22, 22 | 15 |

The round 4 changes that reach the Haiku path (the 2,000-character input cap and the
`observedAt` check) changed nothing measurable here: every development-set report is
short and states no time, and the differences are within run-to-run variation.

- The specialist accepted **11 of 26** reports; **0** of those had service, scope or symptom wrong.
- Most of the router's gain over Haiku alone is scope: Haiku 5.5 tends to leave `scope: unknown` when a building is named (5 of its 6 misses in the first M1 measurement), and the specialist does not.
- Frustration: these rows carry no frustration labels. The frustration head was confident on 23 of 26 and agreed with the lexical rule on 23 of 23.

### Haiku 5.5 details

| Measurement | Fields (run 1) | Over 3 runs × 26 rows | Command |
| --- | --- | --- | --- |
| pre-fix (before the building fill, `44f3f21`) | 150/156, 20/26 exact | 1 keyword fallback, 5 repairs, not repeatable | `LLM_EVAL_RUNS=3 npm run eval:llm` |
| post-fix (`15ac17c`) | 150/156, 20/26 exact | **0 fallbacks**, 5 repairs, not repeatable | same |

- The pre-fix fallback: for "Wired network in the Hillside Academic Building is very sluggish" Haiku returned the canonical location with an empty building code, twice. The fix fills the code by table lookup (DECISIONS.md M2-Q12).
- 5 "unsafe" errors in run 1 (scope, building, room or grouping wrong), in both measurements.
- Recording cost: 29 calls, 51,942 input and 5,038 output tokens (about 1,790 input tokens per call, almost all of it prompt and tool schema). The benefit of the specialist is latency, offline operation and repeatability, not money: a Haiku 5.5 parse costs about $0.0002.

### Hand-written set

**Not measured**: `data/handwritten/reports.jsonl` is still a placeholder. When it
exists, `npm run eval:llm -- <file>` and `npm run eval:router -- <file>` score it.

## Milestone 2: the specialist models

### Training data (synthetic)

```bash
npm run build:training-set
```

| | train | validation | held-out | total |
| --- | ---: | ---: | ---: | ---: |
| templated (8 sentence families × 350, seeded) | 1,622 | 617 | 303 | 2,542 |
| written by Haiku 5.5 (154 batches × 4) | 376 | 104 | 116 | 596 |
| **total** | **1,998** | **721** | **419** | **3,138** |

Dropped by the builder: 87 rows whose scope label contradicted the place the service
itself would find, 191 exact duplicates, 0 development-set texts (6 before two corpus
sentences were removed from the off-topic pool; LEARNINGS.md). One held-out Haiku row
contains a development-set sentence as a substring; it is not in train.

### Training

```bash
npm run train
```

About 4.5 minutes per run on the hardware above (the first run was timed at 4 min 25 s:
5-fold grouped cross-validation over a 5-value C grid, for 4 heads). **Re-running reproduced all three `models/*.json` files byte for byte**
on the same machine. Chosen C = 10 (the grid's top edge) for service, scope and
symptom, and 1.0 for frustration; the grid was deliberately not extended after seeing
this. Temperatures: service 0.80, scope 0.95, symptom 0.55, frustration 0.95.
Thresholds (validation only): **tau = 0.598**, frustration tau = 0.737. Weights file:
1.17 MB, 5,346 buckets.

### Held-out split (419 rows, never used to choose anything)

The held-out rows come from the same generators as the training rows (a held-out
sentence family and held-out Haiku batches), so these numbers are **optimistic** for
hand-written text. The held-out split was looked at once before the place-masking
change (DECISIONS.md M2-Q2), so both runs are shown.

| | before masking | final (masked) |
| --- | --- | --- |
| tau | 0.504 | 0.598 |
| coverage: reports the specialist answers | 176/419 (42.0%) | **180/419 (43.0%)** |
| errors among accepted (any of service, scope, symptom) | 2 (95% CI 0.14–4.04%) | **1 (95% CI 0.01–3.06%)** |
| field accuracy, all rows: service / scope / symptom | 98.6 / 98.1 / 97.1% | 98.8 / 98.8 / 97.1% |
| ECE (10 equal-mass bins): service / scope / symptom / frustration | 0.004 / 0.013 / 0.018 / 0.018 | 0.010 / 0.004 / 0.017 / 0.018 |
| validation: coverage, errors (95% CI) | 267/721, 4 (0.41–3.79%) | 265/721, 4 (0.41–3.82%) |

- Coverage is limited mostly by design, not by confidence: the router never accepts an `unknown` label, and 235 of 419 held-out rows (56%) have an `unknown` service, scope or symptom by construction. Those go to Haiku.
- Risk-coverage curve (held-out, final): below tau the curve reaches 43.9% coverage at 2.7% error; at and above tau = 0.93 there are 0 errors down to 0.2% coverage. Full points in `models/training-report.json`.
- Scope confusion (held-out, all 419 rows): 121 individual→individual, 1 individual→unknown, **1 individual→service_wide** (the costly direction: a personal report counted as a campus-wide one), 100 location→location, 55 service_wide→service_wide, 3 unknown→individual, 138 unknown→unknown.
- The minimum-evidence rule (abstain when fewer than 3 known features fire) changed **0** held-out decisions in both runs and was removed, as ruled.
- Top features per class are printed into `models/training-report.json`. Before masking, "humanities" (a fictional building) was the 5th feature for `symptom=no_connection`; after masking no building name appears.

### Frustration head (against generator labels, not people)

| held-out | before masking | final |
| --- | --- | --- |
| accepted | 399/419 | 396/419 |
| errors among accepted (95% CI) | 17 (2.50–6.73%) | 17 (2.52–6.78%) |
| agreement with labels on the rows it accepts: head vs lexical rule | | **379 vs 363** of 396 |

**Validation met the 5% bound; held-out did not confirm it** (upper end 6.8%). The head
stays on because the threshold came from the pre-declared procedure and the head beats
the lexical rule on the same rows (DECISIONS.md M2 follow-up 3). Its effect is bounded
by the priority policy: a strict majority of reporters, one level at most.

## Milestone 3: correlation on real security alerts

The 514 alerts are produced by Skipa776/detection-engineering-ml from OTRF
Security-Datasets at `d9d40ef` and SigmaHQ rules at `r2026-07-01` (its own pinned
fetch and pipeline, run in this session; it reproduced its published 514 alerts and
17/22 datasets detected, 0 schema errors). They are not committed. Only the aggregates
below are.

```bash
npm run eval:alerts -- /path/to/detection-engineering-ml/out/alerts.jsonl
```

Input sha256 `b4640a268400ae9761bc54d8d25bfc67a6654c666d853b3cfd72bd0c4fe11bb4`:
514 alerts, 0 skipped by the guard, 21 datasets with alerts, 8 hosts. The rule
(DEMO_WINDOW_MS 60 min, ≥ 2 distinct detectors) was committed before this run
(`e11d434`).

N alerts, F firing groups, U alerts in no firing group. Queue reduction = 1 − (F + U)/N
(items a human looks at, against one per alert). Alert coverage = (N − U)/N. Purity =
share of grouped alerts that belong to their group's largest dataset. Fragmentation =
firing groups per dataset. Dataset coverage = datasets with an alert in a firing group.

The table is `npm run eval:alerts` output as printed (round 4 added the items column):

| variant | N | F | U | items for a human (F + U) | queue reduction | alert coverage | purity | impure groups | fragmentation median / max | dataset coverage |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| headline: host, ≥2 detectors, 60 min | 514 | 20 | 78 | 98 | 0.809 | 0.848 | 1.000 | 0 | 1 / 2 | 18/21 |
| window 30 min | 514 | 20 | 78 | 98 | 0.809 | 0.848 | 1.000 | 0 | 1 / 2 | 18/21 |
| window 120 min | 514 | 20 | 78 | 98 | 0.809 | 0.848 | 1.000 | 0 | 1 / 2 | 18/21 |
| baseline: host, no window | 514 | 5 | 27 | 32 | 0.938 | 0.947 | 0.661 | 4 | 1 / 3 | 20/21 |
| baseline: host + UTC day | 514 | 14 | 76 | 90 | 0.825 | 0.852 | 0.909 | 7 | 1 / 2 | 19/21 |
| baseline: producer's correlation_key | 514 | 21 | 251 | 272 | 0.471 | 0.512 | 1.000 | 0 | 1 / 3 | 14/21 |
| severity-weighted 1/2/3/5, ≥4 | 514 | 20 | 78 | 98 | 0.809 | 0.848 | 1.000 | 0 | 1 / 2 | 18/21 |

`npm run triage:alerts` on the same file shows the analyst exactly these 98 items: the 20
candidates, most severe first, then the 78 ungrouped alerts as 6 host lines
(e.g. `HR001.shire.com: 17 alerts, top severity high`).

How to read this honestly:

- **Purity 1.000 is vacuous here.** The vacuity count is **0**: no two datasets on the same host have alerts within an hour of each other, so a 60-minute rule *could not* mix datasets. The baselines without a real window show that mixing is possible and costly (host-only: 4 impure groups, purity 0.661).
- **The window and the weighting changed nothing on this data** (30, 60 and 120 minutes, and severity weights, give identical results). That is a property of these captures, not evidence the choice is unimportant.
- The producer's `correlation_key` (host and first technique) leaves 251 of 514 alerts in no group and reaches 14 of 21 datasets; that is the measured reason for keying on host (DECISIONS.md M3-Q4).
- There are no benign logs, so there is **no precision or false-positive number**; a host with no candidate is not a clean bill of health.

## Other checks (not part of `npm test`)

| Check | Result | Note |
| --- | --- | --- |
| `npm run demo` | runs | flood control narrative |
| `npm run triage:alerts -- vendor/detection-engineering-ml/alerts.synthetic.jsonl` | 2 candidates (WS1, WS3), then WS2 listed as `1 alert, top severity medium`; authors printed | the SYNTHETIC fixture |
| `npm run demo:analyst:e2e` | **11 passed, 0 failed** (round 4 merge, Node 22 and 24) | was 10/10; the added check refuses a non-JSON report |
| `npm run web:e2e` | **21 passed, 0 failed** (round 4 merge, Node 22 and 24; three runs in a row on its branch) | was 17/18: the test killed only the `npx` wrapper, so the first server kept the port and answered for the second (LEARNINGS.md). Three checks added: non-JSON refused, a foreign Host refused, `Retry-After` on 429 |

## Re-measuring

- `npm run record:haiku` (needs `ANTHROPIC_API_KEY`) re-confirms the model id and rewrites `tests/fixtures/haiku-5-5.json`; re-record after any change to the prompt, tool schema or parser post-processing.
- `npm run generate:training-text` (needs the key) rewrites the Haiku training rows; `npm run train` rebuilds the training set and retrains (needs `.venv` from `training/requirements.txt`). The parity, data-hash and size tests then check the result.
