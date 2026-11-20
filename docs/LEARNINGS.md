# Learnings

Facts from building Milestone 1: surprises, mistakes, and approaches that
failed. Newest last.

## Environment

- **The cloud container ran Node 22, not 24.** `package.json` says `24.x`, but `npm` only warns. Node 24.22.3 came from the npm registry's `node@24` package, installed into a side prefix. The existing 447 tests passed on both versions before any change.
- **No way to give this session an Anthropic key.** The cloud credential form refuses Anthropic hosts ("authenticated by the session itself"). That authentication covers Claude Code's own calls, not project code, and using it for the project would be wrong. `api.anthropic.com` answered 401 to a dummy key. Result: no live Haiku call this session, a SYNTHETIC placeholder fixture, and a one-command recording step for Josh.
- **`docs/` was gitignored.** The original `.gitignore` excluded "local project history and planning material", including `docs/`. Writing the requested docs needed that line removed. A second rule, `ARCHITECTURE.md` with no leading slash, matched at any depth and silently left `docs/ARCHITECTURE.md` out of the docs commit. It is now anchored to the root (`/ARCHITECTURE.md`).
- **The e2e scripts leave servers running.** `web/e2e.ts` and `analyst/e2e.ts` start the server through `npx tsx …` and kill only the `npx` wrapper. The real server keeps the port, so the next run talks to a stale server. In the analyst e2e that shows up as a failed login (the one-use token was already spent). In the web e2e it shows up as "server defaults to 127.0.0.1 and prints its host" failing. I first blamed tsx's ".env not found" line for the web failure; the stale process was the cause. With no stale servers: analyst 10/10, web 17/18. The remaining web failure (presentation mode) also happens on the original base commit.
- **`npm audit` reports 13 findings** (11 moderate, 2 high) in vite and launch-editor, which come in through vitest. They were there before this work and are not touched by it.

## Anthropic API facts that shaped the code

- **Claude Haiku 5.5 accepts a forced `tool_choice`**; Opus 5.5, Sonnet 5.5 and Fable 5.x reject it with a 400. My first `eval:models` example named `claude-sonnet-5-5`. The Ponytail review caught that it would have produced "100% provider errors" rather than a parsing result.
- **A forced tool call skips thinking on Haiku 5.5**, so `effort` has nothing to control on this request.
- **Haiku 5.5 rejects non-default `temperature`.** The old client sent `temperature: 0`; the new request sends no sampling parameters.
- **`strict: true` covers types and enums, not cross-field rules.** "Location requires building" and "service_wide cannot have a room" still need our validator and the one repair turn.
- **The SDK's `Message` type has many required fields** (`container`, `diagnostics`, `stop_details`, a large `usage`). Hand-built test doubles copy the full shape so a real recording can drop in without code changes.

## Flood control

- **The consultant caught a race I would have shipped.** My first plan looked up "is there a parent?" without a lock. Thirty concurrent reports would each have seen "no parent" and created one. With `serialize()` disabled as a mutation check, 3 acceptance tests fail, so the test really guards it.
- **My test was wrong, not the code.** I expected the pending recommendation to record 30 reporters. It records 15, the count when the `t2-reporters-15` rule fired, which is more useful to the person applying it.
- **The fixed link window costs a duplicate on long outages.** The scripted outage, with reports at minutes 0–9 and again at 130–139, got 2 INCs (1 missed merge). That is the price of not letting one parent absorb reports forever. The consultant's suggested fix is "parent still in ServiceNow's active search result", which only works in ServiceNow mode.
- **A parent IT closes inside the window keeps absorbing reports**, and the reply would say "a ticket is already open". Recorded as a `shortcut:` in `floodLedger.ts`, not fixed in M1.
- **The per-key queue includes the ServiceNow search.** Fine for a demo; under a real flood each report would wait for every earlier search. Recorded as a `shortcut:`.
- **The old "first N reports each file" behavior is gone for INC-class reports.** The per-topic thresholds (3/5/10) now only matter for ServiceNow peers the ledger doesn't know about and for the advisory pattern detector. The demo narration, one throttle test expectation and the README had to change with it.

## Process

- **Splitting commits needed care.** The parser and flood changes touched the same files (`composition.ts`, `package.json`). I staged parser-only versions of those files, committed, and ran the full suite on that commit in a separate worktree before pushing.
- **Ponytail reviews found something every time:** a bad command example, a stale comment, a dead field, a missing line number in the hand-written-set loader, and a missing canonical-location check that would have silently marked every parser wrong on a mistyped row.

## First real Haiku 5.5 run (2026-11-20)

- **Haiku 5.5 is conservative on scope.** Five of its six misses on the synthetic corpus are `scope: unknown` where a named building should mean `location`, even though the prompt says so. That fails safe (a follow-up question), but it costs field accuracy.
- **It sometimes leaves the building code empty next to a canonical location**, and the repair turn repeats the same answer. Our validator then rejects it and the keyword parser answers, although the building follows from the location by a table lookup.
- **It once wrote a literal `""` (two quote characters) as a field value.** The repair turn fixed that one.
- **Runs are not repeatable.** Haiku 5.5 accepts no temperature setting, and 3 runs of the same 26 inputs gave different answers. The recorded fixture pins one run for the offline tests; accuracy claims need several runs.
- **The prompt is most of the cost:** about 1,790 input tokens per call against about 175 output tokens.


## Milestones 2 and 3 (2026-11-20)

### Process

- **There was no "engineering council" skill to load.** The account and container had none; the closest catalog match (`agentic-council`) cannot be installed from inside a session. Running each persona as a separate agent on one shared brief, with a Chair that names whose view wins, made the disagreements visible and recordable. The two most consequential rulings both overruled my own proposal: one joint abstention threshold instead of three per-field ones, and never accepting a confident `unknown`.
- **A pre-declared trigger fired.** The Chair had ruled against masking building names "unless building tokens appear in the top features". The first training run put "humanities" (a fictional building) 5th for `symptom=no_connection`, so masking went in and the held-out split was looked at a second time. Both runs are in RESULTS.
- **Pre-registration is cheap.** The alert rule's constants were committed (`e11d434`) before the real-data evaluation ran, so the git history shows they were not tuned on it.
- **Commits are now authored as Josh**, with Claude as co-author, from `aeacce1` on. The nine earlier commits on this branch are authored as Claude; changing them would need a force-push.

### Data

- **I leaked the development set into my own templates.** Two off-topic sentences I wrote ("my printer is out of toner", "when is the housing application deadline") were corpus rows I had read. The builder's exact-match guard dropped 6 rows; variants with a tail ("…toner. Thanks.") would have gone into training. Both sentences were replaced. Writing templates after reading the evaluation set is a contamination risk even with good intentions, which is why the development set is reported as counts only.
- **Generated labels are only as good as the generator's obedience.** One Haiku row requested as "frustrated" reads calm. Labels come from the request, so this is label noise; an audit of 50 rows is proposed to Josh.
- **87 rows contradicted their scope label** and were dropped. Two causes were visible: Haiku sometimes mentioned a place when told not to, and the template subject "the lecture hall display" contains a building name, so the location matcher (longest alias wins) reads "the lecture hall display … in HRB" as Lecture Hall. That second one is existing extractor behaviour, not fixed here.
- **The validation-size check caught a rare class**: 29 `equipment_unavailable` rows against a floor of 30, because that symptom exists only for classroom AV. Raising the rows per family from 300 to 350 before training fixed it.

### Models

- **Python and TypeScript agreed to 1e-9 on the first try**, including on non-ASCII, emoji and 2,000-character inputs. The reason is boring: an ASCII-only tokenizer, our own FNV-1a, and both sides summing the same rounded weights in the same order.
- **Retraining reproduced every model file byte for byte** on the same machine. Bit-identical results across machines are not promised (numeric libraries differ).
- **The size estimate was wrong.** The council expected under 1 MB; L2 logistic regression gives every bucket seen in training a non-zero weight, so the file is 1.17 MB for 5,346 buckets. The budget was raised to 1.5 MB rather than making the format less readable.
- **A guard earned its removal.** The minimum-evidence rule changed 0 held-out decisions in two runs and was deleted, as ruled in advance.
- **C landed on the grid's top edge** (10) for three heads. Extending the grid after seeing that would be tuning on results, so it was not extended.
- **My ECE self-check was wrong**: with equal-mass bins, identical confidences are split across bins by row order, so "all 0.8, 80% correct" is not a known-answer case. Known-answer cases need distinct confidences.
- **The frustration head missed its target on held-out** (upper bound 6.8% against 5%) after meeting it on validation. It stays on because it beats the lexical rule on the same rows (379 vs 363 of 396), and the priority policy caps its effect.

- **The final review found a slow path I had added.** Masking place names before hashing re-scanned the whole report once per place mention: 16 KB of "HAB " took 1.65 s, and the endpoint accepts 64 KB. Capping the text the models see at the existing 2,000-character limit brought the worst case to 47 ms without changing any training row or weight.

### Correlation and alerts

- **A test caught my own overclaim.** I wrote that the engine gives "the same output for any input order"; it does for groups and scores, but members with exactly the same time are listed in input order. The comment and the test now say exactly that.
- **The refactor regression was found by review, not by tests.** Moving `PatternDetector` onto the engine made a late event older than the window, arriving alone, crash (the old code returned null). The Ponytail review found it; a test was added and checked to fail without the fix.
- **Purity on the real alerts is vacuous.** No two datasets on the same host are within an hour of each other, so a 60-minute rule cannot mix them; only the no-window baselines show mixing (purity 0.661). Window length and severity weighting changed nothing on this data.
- **The producer's own grouping hint was the weakest key**: grouping by `correlation_key` (host and first technique) left 251 of 514 alerts ungrouped.
- **The producer's pipeline reproduced its published numbers** (514 alerts, 17/22 datasets) in this container from its pinned fetch.

### Environment

- **Rendering the Mermaid diagrams to check their syntax was blocked**: the session's permission classifier refused headless Chromium launched with `--no-sandbox`. The diagrams in ARCHITECTURE.md were checked by reading, not by rendering.
- **The Anthropic key arrived as `BOUNDARY_BENCH_ANTHROPIC_KEY`**, not `ANTHROPIC_API_KEY`; the scripts were run with `ANTHROPIC_API_KEY="$BOUNDARY_BENCH_ANTHROPIC_KEY"`. Nothing in the code reads the other name.
