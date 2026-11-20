# Decisions

Each entry gives the criteria, the options considered, the choice, and what
would change it. Source tags:

- **[spec]**: settled with the Fable design consultant before this session (the Milestone 1 brief).
- **[Fable consultant]**: asked during Milestone 1, on 2026-11-15, because the spec did not settle it. The consultant's answer is recorded as given; where the code deviates, the entry says so and why.
- **[session]**: decided while building, from API facts or as mechanical follow-through.

## 0. Environment check (session start, 2026-11-15, cloud session)

| Check | Result | Consequence |
| --- | --- | --- |
| `docker info` | CLI 29.9.2 present; daemon not running (no `/var/run/docker.sock`) | Nothing in M1 needs Docker. |
| Node | Container default is v22.23.4. Node 24.22.3 installed from the npm registry (`npm install --prefix /opt/node24 node@24`) and put first on `PATH` | All tests and measurements in RESULTS.md ran on Node 24.22.3, as `package.json` `engines` requires. |
| npm | 10.9.9; `npm ci` works | `npm audit` reports 13 findings in dev tooling (vite, launch-editor via vitest), present before this work; not addressed in M1. |
| Python | 3.13.18; scikit-learn not installed | Needed only in M2. |
| `ANTHROPIC_API_KEY` | Not set. `api.anthropic.com` is reachable (HTTP 401 without a key). The cloud credential form refuses Anthropic hosts. | No live model call was possible in this session. See S4. |
| GitHub | `git clone` works (Ponytail skills installed via `npx skills add`) | |
| Hardware | 4 vCPU Intel Xeon @ 2.10 GHz, 15 GiB RAM, Linux 6.18 (more than the 2 CPU / 7 GB in the brief) | Recorded with every measurement. |
| Baseline before changes | 447 tests pass (Node 22 and 24); build and lint pass | |

## Key decisions [spec]

### 1. Keep the read + create boundary
- **Criteria:** the README's safety promise (read and create only); no unattended change to an existing ticket.
- **Options:** (a) parent INC is a create; child reports are never created; links and the counter are local. (b) Give the integration update permission to set `parent_incident` or patch priority.
- **Choice:** (a).
- **Would change it:** an explicit decision by Josh to change the README's safety promise. This is his call to revisit.

### 2. Priority from a deterministic policy table
- **Criteria:** explainable, auditable, not gameable, no model in the decision.
- **Options:** (a) table over distinct-reporter count, service tier (from a policy document), and frustration capped at one level; set once at parent create; later raises are recommendations a human applies. (b) LLM-set priority. (c) Frustration as the main driver.
- **Choice:** (a). (b) puts a model in a decision. (c) is gameable and penalizes polite reporters.
- **Would change it:** evidence that the table misranks real incidents, or a policy owner wanting another input.

### 3. M2 specialists are linear models on hashed n-grams
- **Criteria:** cheap, fast, offline-testable, inspectable weights.
- **Options:** linear models (chosen); small transformers; LLM-only; training in TypeScript.
- **Would change it:** linear models failing their calibration or accuracy targets on the hand-written set.

### 4. The M3 correlation engine sees only `{key, source, time, weight}`
- **Criteria:** one engine, domain meaning owned by adapters.
- **Options:** one engine with ticket and security-alert adapters (chosen); two separate pipelines; a rules DSL.
- **Would change it:** a domain that needs more than those four fields to correlate.

### 5. M2 abstention threshold chosen on a validation set
- **Criteria:** hit a target error rate, not an arbitrary cutoff.
- **Options:** threshold chosen on validation for a target error rate (chosen); fixed 0.5.
- **Would change it:** a validation set too small to estimate the error rate.

## Milestone 1 decisions [Fable consultant]

### C1. Flood ledger versus the existing threshold gate (Q1)
- **Criteria:** keep `decide()` pure; meet "exactly 1 parent create"; keep a backstop when the ledger has nothing.
- **Options:** (a) one pre-computed boolean `evidence.openParent` plus one rule in `decide()`, ordered override > declared incident > open parent > existing peer threshold > file; (b) remove the per-topic peer thresholds.
- **Choice:** (a). The orchestrator does the ledger lookup and write. The old peer rule stays for REQ, for ServiceNow peers not in the ledger, and after a lost ledger. Per-topic thresholds keep driving the advisory pattern detector. The README sentence "early reports still create tickets" is behavior text, not a safety promise, and was rewritten.
- **Would change it:** wanting reports matched to a declared incident to count on the ledger too (the consultant said no).

### C2. Correlation key (Q2)
- **Criteria:** one definition shared by the detector and the ledger.
- **Choice:** `groupKey()` in `clusterGate.ts` (service + building, plus room for classroom AV, service-only for service_wide). Symptom is not in the key. `floodKey()` returns **no key** for individual reports and for location reports with an empty building, because those would collapse into the service-wide key. That is harmless for an advisory alert but wrong for a rule that suppresses creates.
- **Would change it:** building becoming required for location scope.

### C3. How long a parent stays open (Q3)
- **Choice:** fixed: the match window (120 demo minutes) from parent creation, the same semantics the gate applies to peers. Not sliding, which would let one parent absorb reports forever.
- **Would change it:** real outages routinely outlasting the window. Then count the parent while it appears in ServiceNow's `active=true` search result. The scripted scenario "one outage outlasting the link window" measures this cost: 1 missed merge (RESULTS.md).

### C4. Ledger storage (Q4)
- **Choice:** in-memory, behind a small class, like the throttle and idempotency stores. The parent is stored as `ticketNumber` + `url`, **not a separate `sys_id`**. The spec's ledger lists "parent sys_id", but `createTicket` returns `{ticketNumber, url}`, and in ServiceNow mode the URL carries the sys_id, so widening the adapter would add nothing. A restart mid-flood loses the counts and opens a second parent.
- **Would change it:** any non-demo deployment. Then `node:sqlite`, as `src/analyst/ledger.ts` already does.

### C5. Frustration source in M1 (Q5)
- **Choice:** a deterministic lexical signal over the reporter's own words (`src/frustration.ts`), **boolean**, separate from `ProblemReport` (which stays 8 fields). No model involvement in M1. The M2 "score" specialist replaces it. Not validated against real people.
- **Would change it:** the M2 score model being trained on ordinal labels.

### C6. Policy shape (Q6)
- **Choice:** `policy.example.yaml` (SYNTHETIC): `service_tiers` for every catalog service; `rules: {id, tier, min_distinct_reporters, priority 1-5}`. The rule used is the highest `min_distinct_reporters` reached in the tier. Frustration is a **strict majority** of distinct reporters and raises one level (the cap is in code). The file is validated at load (every service has a tier, every tier has a min-1 rule). Priority is written at create as impact + urgency via a fixed mapping in the ServiceNow adapter, labelled as an instance assumption. REQ gets no priority. At create the count is 1, so "majority" reduces to the parent reporter, and one rule covers both create and later recommendations.
- **Would change it:** a customised impact × urgency lookup on the instance. The example keeps every count-1 rule at P3 or lower, so one frustrated report cannot create a P1 unattended.

### C7. Recommendation semantics (Q7)
- **Choice:** at most **one pending recommendation per parent**, replaced on a further rise, always citing the rule id, with an audit line (`recommended`) per change. No ServiceNow write.
- **Would change it:** nothing under the current spec. One recommendation per rise would fail the "ONE recommendation" acceptance test, because a 30-report burst crosses two rule steps.

### C8. Identity salt (Q8)
- **Choice:** `REPORTER_HASH_SALT` from the environment. Startup **fails** if ServiceNow is configured and the salt is missing: stored `u_reporter_hash` values must stay comparable across restarts. With no ServiceNow, a random per-process salt is used.
- **Deviation:** the consultant suggested printing a one-line notice when the random salt is used. Not done: in in-memory mode every bit of state dies with the process, so the random salt changes nothing observable, and the notice would print in every test.
- **Would change it:** live mode never reading hashes written by an earlier process.

### C9. `eval:models` (Q9)
- **Choice:** moved to the Anthropic parser path, comparing Claude model ids on the same request. Token counts come from each response's `usage`; the provider's `/utils/token_counter` and the "Counted input" UI column were removed. The analyst *proposal* model and `chatClient.ts` stay on the OpenAI-compatible client, unchanged.
- **Would change it:** needing to compare non-Claude parsers again.

### C10. YAML parsing, a new dependency (Q10)
- **Criteria:** the real policy is edited by people outside the repo; the spec names a `.yaml` file.
- **Options:** `yaml` package; JSON written in a `.yaml` file and read with `JSON.parse`; a hand-rolled parser.
- **Choice:** `yaml` **2.9.1, pinned exactly** (no dependencies of its own), plus hand-written validation of the parsed object. A JSON-only ".yaml" is a trap for the person editing it; a hand-rolled parser is more code than the dependency.
- **Would change it:** accepting `policy.example.json`. Then `JSON.parse` and no dependency.

### C11. Hand-written test set format (Q11)
- **Choice:** JSONL with the six graded fields; optional `frustrated: true|false` (for M2) and `groupId`; `service` may be an array. The placeholder is marked at file level (one `_placeholder` line), and the eval exits with a message rather than refusing per row. Format: `data/handwritten/README.md`.
- **Would change it:** frustration going ordinal.

### C12. API outcome for a linked report (Q12)
- **Choice:** reuse `MATCHED_CLUSTER`; the HTTP contract does not change. The count is distinct ledger reporters other than the caller, and `ticketIds` is the parent. The composer's text ("N other people… a ticket is already open… I have not created another one") is exactly true for a linked report and makes no status claim.
- **Would change it:** clients needing to tell linked reports from threshold-deflected ones. Then add a field, not an outcome.

### C13. Issues the consultant raised unprompted (Q13)
1. **Concurrency.** Reports for the same flood key now run one at a time from ledger lookup through create (`InMemoryFloodLedger.serialize`). The acceptance test fires all 30 concurrently. Disabling the queue makes 3 acceptance tests fail (checked by mutation; LEARNINGS.md).
2. **Ambiguous parent create.** After `AmbiguousCreateError` the key is marked pending (`ticketNumber: null`), and later reports for it get `UNAVAILABLE` until the window passes.
3. **Override.** Still files during a flood (the reply offers it), never joins or replaces the parent, and is recorded by the feedback sink. "0 further creates" in the acceptance test excludes overrides.
4. **Counter.** Derived from the reporter-hash set (1 + 29 = 30), so idempotent repeats and same-reporter rewordings do not increment it.
5. **Parser.** A `refusal` stop reason goes straight to the keyword fallback with no repair turn; no temperature is sent; the SDK call is injected as a function for recorded-response tests rather than mocking the SDK.

## Milestone 1 decisions [session]

### S1. Anthropic SDK version
- **Choice:** `@anthropic-ai/sdk` `^1.8.0`. The 1.x line sends API version `2026-10-21`, which rejects `temperature`/`top_p`/`top_k`, and none is sent.
- **Would change it:** a breaking 2.x release.

### S2. The parser request
- **Criteria:** schema-valid output without text scraping; fast fallback when the API is slow.
- **Choice:** `tool_choice: {type: 'tool', name: 'record_report_fields'}` with `strict: true` on the tool. Haiku 5.5 accepts a forced tool; Opus 5.5, Sonnet 5.5 and Fable 5.x reject it. No `thinking` setting, because a forced tool call skips thinking on Haiku 5.5. No `effort` setting, for the same reason: there is no thinking for it to control, and the default (`medium`) applies. `max_tokens: 1024`, `timeout: 10s`, `maxRetries: 0`, matching the old client: a hung parse must become a keyword parse quickly. No prompt caching (not measured; the system prompt is short and Haiku 5.5 input is $0.10/MTok).
- **Would change it:** measured latency or accuracy on the hand-written set; `effort` matters only if the request moves to `tool_choice: auto`.

### S3. The repair turn
- **Choice:** the validator's error goes back as an `is_error` `tool_result` for the model's own tool call, then one more forced call. Still at most two calls per report.

### S4. Recorded responses without a key
- **Criteria:** tests offline; never present made-up data as recorded.
- **Choice:** `tests/fixtures/haiku-5-5.json` is a **SYNTHETIC placeholder** (`"recorded": false`): hand-built responses in the exact Messages API shape for three corpus inputs. `npm run record:haiku` confirms the model id with the Models API, records real responses for all 26 corpus inputs, and sets `"recorded": true`. The replay test asserts the parser reproduces exactly what it produced at record time; it is not an accuracy claim. Failure modes (refusal, no tool call, invalid fields) are separate hand-built test doubles.
- **Would change it:** nothing. Josh runs the record step once with a key (RESULTS.md, "Steps for Josh's Mac").

### S5. What happened to the old OpenAI-compatible client
- **Choice:** kept for the analyst proposal model (`src/analyst/model.ts`, `analyst/server.ts`). Its token counter and usage tracking had no remaining consumer and were deleted. `extractFirstJsonObject` moved to its only remaining user, `src/analyst/model.ts`, with its tests.

### S6. Node 24
- **Choice:** installed from the npm `node@24` package into `/opt/node24` in the cloud container, not the system Node. Nothing in the repo depends on it.

### S7. `docs/` was gitignored
- **Choice:** removed the `docs/` line from `.gitignore` so these documents can be committed, and anchored `ARCHITECTURE.md` to the root (`/ARCHITECTURE.md`) because it also matched `docs/ARCHITECTURE.md`. The other "local planning material" entries stay.

### S8. README length
- **Choice:** the README is now short (what it is, how to run, results, limits). Setup detail moved unchanged to `docs/SETUP.md`. The README's Safety Boundaries list is kept word for word.

## How Milestone 2 and 3 decisions were made: the engineering council [session]

- **Asked for:** "use the /engineering council skills and personalities to review engineering decisions."
- **Found:** no such skill is installed in this account or container. The closest catalog match is the
  `agentic-council` plugin (a `/council` command with personas); it was offered as an install card,
  since plugins cannot be installed from inside a session.
- **Done instead:** for each open decision, four personas, each a separate Fable agent with one lens, read the
  same brief and answered independently: **Architect** (structure, readability), **Skeptic** (evaluation
  validity), **Guardian** (safety, untrusted input, licensing), **Operator** (determinism, size, operations).
  A fifth Fable agent, the **Chair**, read all four and issued binding rulings, naming whose view won.
  Follow-up questions went back to the same Chair. Briefs, positions and rulings are summarized below; the
  rulings are quoted as decisions, not as evidence.
- **Would change it:** installing the `agentic-council` plugin; then its `/council` command replaces this.

## Milestone 2 decisions [engineering council, 2026-11-20]

### M2-Q1. Four heads
- **Choice:** service, scope, symptom, and a boolean frustration head. Location, building and room stay
  vocabulary lookup (they feed thresholds and the flood key); `observedAt` stays Haiku-only. (Until
  R4-2 they also fed the idempotency key; it is now the words only.)
- **Would change it:** the hand-written set showing the lookup, not classification, as the main error source.

### M2-Q2. Features
- **Choice:** our own FNV-1a 32-bit hash, ASCII-only lowercasing, `[a-z0-9]+` tokens (first 400), word
  1+2-grams, binary presence, 2^16 buckets (Architect over Operator's 2^14: file size depends on buckets
  seen, not on D). No character n-grams.
- **Place masking (follow-up ruling):** first ruled out (it would need a second building matcher in Python).
  After the first training run put "humanities" (a fictional building) among the top features of
  `symptom=no_connection`, the Chair's own trigger fired: places are now replaced by `xplacex` in TypeScript
  (`maskPlaces`, the service's own matcher), the builder stores the masked text, and Python never sees a
  building name. The held-out split had been looked at once before this change; RESULTS shows both runs.
- **Would change it:** grouped cross-validation showing character n-grams gain ≥ 2 points.

### M2-Q3. Model and calibration
- **Choice:** multinomial L2 logistic regression; C from the fixed grid [0.1, 0.3, 1, 3, 10] by 5-fold
  GroupKFold on train (groups = template family or Haiku batch); one temperature per head from a fixed grid
  (0.50–5.00, step 0.05) minimizing validation log loss.
- **Measured note:** C = 10 (the grid's top edge) won for service, scope and symptom. The grid was
  deliberately **not** extended after seeing that (follow-up ruling 2), because that would be tuning on results.

### M2-Q4. Abstention threshold (Skeptic won)
- **Options:** per-field targets (5% service and symptom, 2% scope); one joint target.
- **Choice:** ONE threshold tau over the minimum of the three report heads' calibrated confidences, the
  lowest tau whose two-sided 95% Clopper-Pearson **upper** bound on whole-report error among accepted
  validation reports is ≤ 5%, with the full acceptance rule applied. Floor 0.5, checked again at load. No
  tau meets it: `tau: null`, specialist off. Per-field targets were rejected because, ANDed together, they
  permit about 12% whole-report error.
- **Would change it:** coverage near zero at 5%; then report it, do not loosen silently.

### M2-Q5. Router semantics
- **Choice:** whole report, one source, no per-field mixing. A specialist answer is used only if it is
  confident AND passes the same field rules a Haiku answer must pass (now in `src/parser/fieldRules.ts`)
  together with the deterministic places.

### M2-Q6. Where frustration lives (Architect lost)
- **Choice:** the router puts the frustration head's answer on `ParseResult.frustrated`, only when confident,
  whichever parser answered the fields; the orchestrator uses `parsed.frustrated ?? isFrustrated(text)`.
  Haiku is not asked; `ProblemReport` and the priority policy are untouched.
- **Why not inside `frustration.ts`:** stage 1 would then silently use a model.

### M2-Q7. Training data
- **Choice:** templates and the explicit valid label combinations in one JSON file; templated rows (seeded)
  and Haiku-written rows, **both committed** with a split column (Operator lost: committed rows are
  inspectable and make stale weights detectable offline). Splits grouped by template family / Haiku batch:
  train, validation (temperature and tau), synthetic held-out (only measured). Validation ≥ 500 rows and
  ≥ 30 per class, asserted by the builder. Labels are the requested ones; the development set and the
  hand-written set are never sent to Haiku or used as seeds; exact duplicates are removed across splits.
- **Session note:** the builder's first run raised validation `equipment_unavailable` to 29 < 30, so rows per
  family went from 300 to 350 before any training.

### M2-Q8. The 26 corpus rows are a development set (Skeptic won)
- **Choice:** the keyword parser and the M1 prompt were tuned on them, and the templates were written by
  someone who had read them. They get counts only (accepted n, errors k, per parser), no ECE or curve.
  Haiku is run 3 times, mean and range.

### M2-Q9. Artefacts
- **Choice:** `training/` holds the one script and pinned `requirements.txt` (gitignored `.venv`);
  `models/weights.json` carries a header with the feature configuration, label lists, seed, library versions,
  dataset sha256, C, temperatures and thresholds. Parity fixtures come from the ROUNDED exported weights;
  TypeScript must match to 1e-9 with identical accept/abstain decisions. `npm test` never runs Python.

### M2-Q10. Files
- **Choice:** `src/parser/features.ts` (the parity-critical part), `src/parser/specialist.ts`,
  `src/parser/router.ts` (a plain `Parser`). The audit records source, three confidences, tau and the data
  hash; `decide()` never sees confidences.

### M2-Q11. Safety of the specialist path
- **Choice:** stage 2 only; never accept a specialist `unknown` (it would skip Haiku on exactly the hard
  reports); output passes `normalize()`; a throw or a bad weights file means "abstain" / "specialist off",
  never a failed request. Keyword-stuffed reports are tests that check the output still obeys the field
  rules; they are reported, not claimed as defended.
- **Minimum-evidence rule:** proposed (abstain when fewer than 3 known features fire), then **removed** as
  the ruling required: it changed 0 held-out decisions in both runs.

### M2-Q12. Deterministic building fill
- **Choice:** when Haiku returns an exact canonical location with an empty building code, the code is filled
  by table lookup before validation; a contradicting building still fails. The Haiku baseline was re-run;
  the earlier number is labelled "pre-fix".

### M2-Q13. Reporting rules
- **Choice:** the Skeptic's metric definitions (RESULTS.md); "observed k/n, 95% interval", never "achieves
  target"; the benefit is latency, offline operation and repeatability, not money. Refitting tau on Josh's
  set was rejected (that is tuning on the test set).

### M2-S1. The models see at most 2,000 characters [session, found in the final review]
- **Problem:** `maskPlaces` re-scans the text once per place mention, so its cost grows with the square of
  the mentions. The web endpoint accepts 64 KB bodies; 16 KB of "HAB " took 1.65 s, and a full 64 KB body
  of building codes would block the service for much longer.
- **Choice:** `modelText()` in `features.ts` keeps the first `VERBATIM_MAX_LEN` (2,000) characters, the cap
  the reporter's own words already get, then masks. Inference and the training-set builder both call it,
  so Python and TypeScript still see identical text. All training rows are shorter than the cap: the
  training data and the weights are byte-identical; only the parity fixture for one long input changed.
  Measured worst case after the cap: 47 ms for a 64 KB stuffed body.
- **Would change it:** a linear-time masker (one combined pattern), if 2,000 characters ever proves too few.

### M2 follow-up rulings (after the first training run)
1. **Masking:** see M2-Q2.
2. **Size:** the 1 MB weights budget was an estimate to catch runaway growth; raised to 1.5 MB, readable
   nested format and 6 decimals kept. (The masked model is 1.17 MB.)
3. **Frustration head stays on** although its held-out upper bound (6.8%) is above 5%: the threshold came from
   the pre-declared procedure, and switching it off after seeing held-out would be post hoc. The off-switch
   condition: the lexical rule agreeing with the labels at least as well on the same rows. Measured: the head
   379/396 vs lexical 363/396 on the rows it accepts, so it stays.

### M2 proposals for Josh (not applied)
1. README Safety Boundaries line: "A specialist that abstains or fails falls through to the next parser."
2. Should a single first reporter's frustration raise priority at all? Today 1 of 1 is a majority.
3. Audit 50 random Haiku-generated rows and report the label agreement.
4. Write the hand-written set with ≥ 40 frustrated and ≥ 40 not; optionally reserve a labelled slice for a
   tau refit, declared before anyone looks.
5. Confirm the one-line orchestrator change for frustration (M2-Q6) against the stage-seam comment.

## Milestone 3 decisions [engineering council, 2026-11-20]

### M3-Q1/Q2. The engine (Architect won)
- **Choice:** `correlate(signals, windowMs)` in `src/correlate.ts`: a pure batch function over
  `{key, source, time, weight}`. Per key, sorted by (time, input index); a group starts at its first signal
  and takes every signal at most `windowMs` later; the next one opens a new group (fixed, not sliding). It
  returns score (sum over distinct sources of each source's highest weight), first/last time and member
  indexes. No clock, no threshold, no state. "Raise once, then update", the clock and the per-topic
  threshold stay in `PatternDetector`; the flood ledger stays separate (it gates a create, and the action
  path must not share code with attacker-influenced alert input).
- **Rejected:** an `asOf` trailing window (overlapping windows give no group definition for the metrics).
- **Would change it:** ticket events arriving future-dated (the one-group guarantee in the ticket adapter breaks).

### M3-Q3. Who compares against the threshold
- **Choice:** each adapter, in one commented line: tickets `score > thresholdFor(...)` (unchanged, strict),
  alerts `score >= DEMO_MIN_DETECTORS`. Characterization tests pin today's ticket edges (strict cutoff,
  threshold + 1, silent update, arrival order) and stayed green through the refactor.

### M3-Q4. Alert key, source and weight (Skeptic won on weights)
- **Choice:** key = `entity.host` (validated, lowercased), never the producer's `correlation_key`
  (host|first technique splits one intrusion into fragments, and it has no pattern or length limit);
  source = `detector.id`; time = `time_observed`; weight 1 in the headline. Severity weights 1/2/3/5 with
  ≥ 4 appear only as a comparison row: with critical = 5, one alert would fire a group, a severity filter
  rather than correlation.

### M3-Q5. Advisory only
- **Choice:** `incidentCandidates()` and `npm run triage:alerts -- <path>`; no network, no ServiceNow
  create, no model. Attacker-shaped input must not trigger a write, and there is no benign data to give a
  false-positive rate.

### M3-Q6. Contract and validation; a new dev dependency
- **Choice:** the schema and the producer's SYNTHETIC fixture are vendored byte for byte under
  `vendor/detection-engineering-ml/` (commit `c5cefed`, sha256 pinned by a test). **`ajv` 8.20.0, exactly
  pinned, dev dependency, contract test only** (`ajv/dist/2020`; eslint's transitive ajv 6 cannot do JSON
  Schema 2020-12). At runtime a hand-written guard reads only the fields grouping needs, rejects any
  `schema_version` but "1.0", and fails closed (skip and count). Tests check: both hashes; the fixture passes
  ajv and the guard; a mutation table is rejected by both; the guard is stricter where untrusted text becomes
  a key or output. All five fixture alerts are Sigma, so the anomaly branch is untested.
- **Would change it:** Node gaining a built-in 2020-12 validator.

### M3-Q7. DEMO constants, PRE-REGISTERED 2026-11-20 before any evaluation on real alerts
- **Choice:** `DEMO_WINDOW_MS` = 60 minutes and `DEMO_MIN_DETECTORS` = 2, labelled DEMO at the top of
  `src/alertAdapter.ts`, not routed through `configureGate`. The council had seen the producer's alert
  count (514) but no purity or coverage number. They are committed in git before `npm run eval:alerts` is
  run on the real file.
- **Would change it:** a change after evaluation must be labelled as tuned on results.

### M3-Q8. Evaluation
- **Choice:** `npm run eval:alerts -- <path>` takes a path, fetches nothing and prints the input sha256.
  Metrics: queue reduction, alert coverage, micro purity with the impure-group count, fragmentation, dataset
  coverage, and the vacuity count (definitions in the script and RESULTS.md). Rows: headline; 30 and 120
  minutes; host with no window; host + UTC day; `correlation_key`; severity-weighted. `ground_truth` is read
  in that script only, after grouping. Only aggregates are committed; no hostnames, titles or per-alert rows;
  no precision or false-positive claim.

### M3-Q9. Files (Architect won)
- **Choice:** flat: `src/correlate.ts`, `src/alertAdapter.ts`, and `src/patternDetector.ts` stays as the ticket
  adapter (same export, same tests). `clusterGate.ts` untouched.

### M3-Q10. Untrusted alert fields
- **Choice:** host must match `^[A-Za-z0-9._-]{1,64}$` or the line is skipped (no truncation or replacement,
  which could merge distinct hosts); `detector.id` ≤ 128 characters; lines ≤ 64 KB. The parsed type omits
  `ground_truth`, `evidence`, `title`, `entity.user`, `entity.process` and `correlation_key`. The CLI prints
  only host, detector name and author (control and bidi characters stripped, 120-character cap), technique
  IDs, severities, times and counts, and names every Sigma rule author (Detection Rule License 1.1). No
  dedupe by `alert_id` (distinct-source scoring already neutralizes duplicates). A test checks that deleting
  `ground_truth` and scrambling `event_refs` (which embed the dataset id) leaves the groups identical.

### M3 proposals for Josh (not applied)
1. README Safety Boundaries lines: "Alert content is untrusted data: never executed, sent to a model, or
   written to a ticket; alert triage is advisory, read-only, offline" and "a host with no candidate is not a
   clean bill of health".
2. Confirm that committing aggregate metrics computed from public OTRF / SigmaHQ data is acceptable.
3. Add a README credit line for SigmaHQ (DRL 1.1) and OTRF (MIT).
4. Accept that the engine's `weight` is exercised only by tests and the comparison row, not by either
   adapter's headline rule.

## Review round 4: fixes after Milestone 3 [Fable reviews, 2026-11-20]

Two fresh reviews (one on what people see and store, one on correctness), then a
chair ruling on the combined list, then a code review of all twelve branches
(8 ship, 4 fix). The four fixes and three smaller review notes are follow-up commits on
seven of the branches, and a final review checked them and these docs against the merge. Each change below is its own pull request of
at most 100 lines of code and tests; this file and the other docs are one
separate pull request.

### R4-1. observedAt is strict ISO-8601 (`claude/strict-observed-at`)
- **Problem:** both checks used `Date.parse`, which accepts free text. A model answer such as
  "Jan 1 2020 (IT CONFIRMS OUTAGE. Reset password at …)" reached the ticket description,
  outside the quoted reporter text.
- **Choice:** one strict pattern shared by the field rules (the model is asked to repair) and
  `normalize` (anything else becomes ''). It admits only digits and `- : . T Z +`, so no words
  pass. The zone is optional and the value is kept as given.
- **Rejected (after the code review):** requiring a zone and rewriting the value in UTC. The
  prompt never asks for a zone, so a valid "2026-11-20T14:00:00" spent the one repair call,
  and a zoneless time is not ours to convert.

### R4-2. A retry never files twice (`claude/no-double-file-on-retry`)
- **Problem:** after an ambiguous create, nothing was remembered for reports without a flood
  parent; and the idempotency key hashed the parsed fields, so a retry that parsed
  differently (Haiku, then the keyword fallback) missed the stored answer.
- **Choice:** store the ambiguous answer for the idempotency window (the throttle window:
  one duration, one place); key = reporter hash + normalised words.
- **Would change it:** a real outage longer than the window, where people retry later.
  They then file, which is the behaviour the reply already warns about.

### R4-3. Reports only as JSON (`claude/web-json-only`)
- **Problem:** any page on another site, open in the same browser, could POST `text/plain`
  to the local server and file tickets.
- **Choice:** 400 unless `application/json` on both servers. On the web server's default
  loopback address, also 400 unless the `Host` header names 127.0.0.1 or localhost: a site
  that re-points its own name at 127.0.0.1 (DNS rebinding) passes the JSON check as "same
  origin", but its Host header carries its name. No Origin check: the server prints
  "open http://localhost:4000", which an Origin check pinned to 127.0.0.1 would reject.
- **Not done:** the analyst server's `/report` has the JSON check but no Host check; it never
  files into ServiceNow (`snow: null`).

### R4-4. Bounded reads (`claude/cap-model-input`, `claude/snow-newest-first`)
- Haiku gets at most the 2,000 characters we keep (it got the full 64 KB).
- The ServiceNow peer search orders newest first, so recent peers are inside its 100-record page.

### R4-5. What IT and callers can see
- `claude/server-visibility`: opt-in `AUDIT_LOG_PATH` file sink, read only by the servers, no
  cap; recommendations and pattern advisories are printed to the web server's console.
  **Rejected:** a `GET /ledger` endpoint: unauthenticated staff data beside the public form.
- `claude/retry-after`: `retryAfterSeconds` and `Retry-After` on THROTTLED (the analyst
  server returns the body field only).
  **Rejected:** exposing UNAVAILABLE's internal `reason`: it would freeze an internal
  vocabulary into the API, and after R4-2 no caller needs it.
- `claude/audit-replied`: one closing `replied` line with `apiOutcome` per request.
  **Rejected:** trimming fields from `searched` (they log the effective report, whose scope
  can differ from the parsed one) and omitting empty strings (churn for no reader).
- `claude/triage-queue`: candidates most severe first; ungrouped alerts listed by host.
  **Rejected:** `--json`: no consumer yet.
- `claude/reply-wording`: readable status time (only a full ISO date-time with a zone; anything
  else is shown as given, because a zoneless time would be read in the server's zone); no
  "0 other people" reply, and the page's chip says "N other reporters".

### R4-6. Dropped or waiting
- **Reformatting `models/weights.json` to one bucket per line: dropped.** About 4,900 changed
  lines of generated data would break the 100-line rule for no behaviour change. Revisit at
  the next retrain.
- **Moving the throttle ahead of the parse: waiting for Josh.** It saves model calls for
  throttled callers, but it changes the README flow and the lifecycle order, and the
  `throttled` audit line would lose `service`. A caller can bypass the throttle anyway by
  rotating `identityRef` (README Known Limits).
- **Kept as deliberate:** `Evidence.withinWindow` (the purity seam `decide.test.ts` exercises)
  and `void new UnwiredStatusReader()` (the visible stage-3 seam).

