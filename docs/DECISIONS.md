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
