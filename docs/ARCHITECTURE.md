# Architecture

State after Milestone 3. The rule that shapes everything: **models only read
text; deterministic code decides.** The parser turns words into bounded fields.
Whether to create a ticket, link to one, or set a priority is decided by plain
code that a test can pin down.

## Context

```mermaid
flowchart LR
    reporter["<b>Reporter</b><br/>web form or chat assistant"]
    svc["<b>Campus Issue Reporter</b><br/>this repo"]
    claude["<b>Anthropic API</b><br/>Claude Haiku 5.5<br/>reads text only"]
    detml["<b>detection-engineering-ml</b><br/>security alerts (JSONL)"]
    analyst["<b>Security analyst</b><br/>reads incident candidates"]
    snow[("<b>ServiceNow</b><br/>read open records<br/>create a ticket")]
    policy[/"<b>Priority policy</b><br/>YAML, outside the repo<br/>(synthetic example inside)"/]
    it["<b>IT agent</b><br/>works the ticket,<br/>applies priority recommendations"]
    noc["<b>NOC</b><br/>advisory pattern alerts"]

    reporter -->|report text| svc
    svc -->|reply| reporter
    svc -.->|parse, optional| claude
    svc -->|search, create| snow
    policy -->|loaded at startup| svc
    svc -.->|recommendation, server console| it
    svc -.->|candidate alert, server console| noc
    it --> snow
    detml -->|alerts.jsonl, schema 1.0| svc
    svc -.->|incident candidates, CLI| analyst
```

Solid arrows are the request path; dashed arrows are optional or advisory.
Nothing in this service can update, close or comment on a ServiceNow record.

## Components

```mermaid
flowchart TD
    api["api.ts<br/>HTTP shape"]
    orch["orchestrator.ts<br/>one request's lifecycle"]

    subgraph parse ["Parser (the only model-facing part)"]
        router["parser/router.ts<br/>stage 2: specialist first"]
        spec["parser/specialist.ts<br/>local linear models"]
        llm["parser/llmParser.ts<br/>Haiku 5.5, forced tool"]
        kw["parser/keywordExtractor.ts<br/>fallback, no network"]
        rules["parser/fieldRules.ts<br/>shared validity rules"]
        norm["parser/reportParser.ts<br/>normalize: 8 bounded fields"]
    end

    subgraph det ["Deterministic core"]
        gate["clusterGate.ts<br/>keys, thresholds, window"]
        engine["correlate.ts<br/>{key, source, time, weight}"]
        ledger["floodLedger.ts<br/>parent + child reporters"]
        decide["decide.ts<br/>pure decision"]
        pol["priorityPolicy.ts<br/>policy table"]
        frus["frustration.ts<br/>boolean signal"]
        comp["composer.ts<br/>fixed reply templates"]
    end

    subgraph adapters ["Adapters (the method list is the safety control)"]
        sn["adapters/servicenow.ts<br/>search + createTicket"]
        mem["adapters/memory.ts<br/>in-memory stand-ins"]
    end

    audit["audit.ts<br/>append-only JSONL"]
    detector["patternDetector.ts<br/>ticket adapter, advisory alerts"]
    alerts["alertAdapter.ts<br/>security-alert adapter"]
    root["composition.ts<br/>wires it all, reads env"]

    api --> orch
    orch --> router
    router --> spec
    router -->|abstain| llm
    router --> rules
    llm --> rules
    llm -->|fallback| kw
    llm --> norm
    kw --> norm
    orch --> gate
    orch --> ledger
    orch --> decide
    orch --> pol
    orch --> frus
    orch --> comp
    orch --> sn
    orch --> mem
    orch --> audit
    orch -.->|events| detector
    detector --> engine
    alerts --> engine
    root --> orch
```

## The stage-2 parser: specialist, then Haiku, then keyword

```mermaid
flowchart LR
    text["report text"] --> mask["maskPlaces + hash<br/>features.ts"]
    mask --> heads["4 linear heads<br/>service · scope · symptom · frustration"]
    heads --> confident{"min confidence ≥ tau<br/>and no 'unknown'?"}
    confident -->|yes| places["places from the<br/>deterministic lookup"]
    places --> valid{"field rules pass?"}
    valid -->|yes| done["source: specialist"]
    confident -->|no| haiku["Claude Haiku 5.5<br/>(keyword if no key)"]
    valid -->|no| haiku
    haiku --> done2["source: llm or keyword"]
    heads -.->|frustration, if confident| done
    heads -.->|frustration, if confident| done2
```

The specialist never decides anything downstream: it proposes catalog labels, and a
proposal is used only when it is confident AND passes the same field rules a Haiku
answer must pass. Stage 1 never loads a model.

## Training the specialists (offline, one Python script)

```mermaid
flowchart LR
    tpl["training/templates.json<br/>phrases, valid label combos"] --> build
    gen["scripts/generateTrainingText.ts<br/>(network, run once)"] --> haikujsonl["data/train/haiku.jsonl"]
    haikujsonl --> build["scripts/buildTrainingSet.ts<br/>seeded; masks places; grouped splits"]
    build --> ds["data/train/dataset.jsonl"]
    ds --> py["training/train.py<br/>scikit-learn"]
    py --> w["models/weights.json"]
    py --> fx["models/parity-fixtures.json"]
    py --> rep["models/training-report.json"]
    w --> ts["src/parser/specialist.ts"]
    fx --> parity["tests/specialistParity.test.ts<br/>TS = Python to 1e-9"]
```

Python sees only the place-masked text; all text handling (masking, location
extraction) is TypeScript, so there is one building matcher.

## Security alerts: the second adapter of the same engine

```mermaid
flowchart LR
    jsonl["alerts.jsonl<br/>(untrusted)"] --> guard["parseAlertLine<br/>fail-closed guard, stricter than the schema"]
    guard --> signals["signals: key = host,<br/>source = detector id, weight 1"]
    signals --> engine["correlate()<br/>fixed 60-minute windows"]
    engine --> rule{"≥ 2 distinct detectors?"}
    rule -->|yes| cand["incident candidate<br/>(advisory; authors credited)"]
    rule -->|no| rest["counted, not dropped"]
```

The ticket side uses the same `correlate()`: `patternDetector.ts` turns report
events into signals (key = groupKey, source = reporter hash, weight 1) and raises an
advisory alert when the score is more than the topic's threshold.

## Data flow: a burst of reports about one problem

```mermaid
sequenceDiagram
    participant R1 as Reporter 1
    participant R2 as Reporter 2..30
    participant O as Orchestrator
    participant P as Parser
    participant L as Flood ledger
    participant S as ServiceNow

    R1->>O: "wifi in North Residence Hall keeps dropping"
    O->>P: text
    P-->>O: {wifi, location, NORTH RESIDENCE HALL, ...}
    Note over O: identity hash, throttle,<br/>idempotency, completeness
    O->>L: queue on key wifi|NORTH RESIDENCE HALL
    L-->>O: no open parent
    O->>S: search (read)
    S-->>O: no qualifying match
    Note over O: decide → FILE_INCIDENT<br/>priorityFor(tier 2, 1 reporter) → P4, rule t2-reporters-1
    O->>S: createTicket (the one create)
    S-->>O: INC0000001
    O->>L: start parent INC0000001, reporters {R1}
    O-->>R1: FILED_INCIDENT

    R2->>O: same problem, different reporter
    O->>L: queue on the same key (waits for R1's turn to finish)
    L-->>O: open parent INC0000001
    O->>S: search (read; a declared incident would still win)
    Note over O: decide → MATCHED_CLUSTER (linked_to_parent)
    O->>L: add reporter hash; at 5 and 15 reporters the<br/>policy calls for a raise → one pending recommendation
    O-->>R2: MATCHED_CLUSTER, "a ticket is already open (INC0000001)"
```

What the 30-report burst leaves behind: one INC in ServiceNow (created at P4),
30 reporter hashes on the ledger, and one pending recommendation ("raise to
P2, policy rule t2-reporters-15") for a person to apply.

## Request lifecycle, step by step (`src/orchestrator.ts`)

1. **Parse**: stage 1, the keyword parser; stage 2, the router (specialist, then `llmParser` when a key is set, else keyword). Never throws. Every parser sees at most the first 2,000 characters, the same cap as the stored text.
2. **Identity**: salted hash of the caller's opaque reference.
3. **Throttle**: per-reporter budget, before any read load.
4. **Idempotency**: the same reporter and the same words get the same answer back. The key is the reporter hash and the normalised words only, so a retry that parses differently still matches.
5. **Completeness**: ask for one missing detail, or fall back to a request.
   - **5b. Flood key**: INC-class reports with a building, or service-wide reports, get a key; others skip the ledger. Reports for one key run one at a time from here.
   - **5c. Flood ledger**: is a parent open for this key? (If its create had an unknown outcome: UNAVAILABLE.)
6. **Search**: ServiceNow read, retried once; never falls through to a create.
7. **Reduce**: candidates become booleans and counts.
8. **Decide** (`decide.ts`): override > declared incident > open parent > peer threshold > file.
9. **Act**: quote a declared incident, link to the parent, or create one ticket (an INC gets its priority from the policy and becomes a parent). If a create's outcome is unknown (timeout, 5xx), the UNAVAILABLE answer is stored, so a retry is not a second create.
10. **Fan out**: event to the advisory pattern detector. The web server drains it after answering and prints advisories and new priority recommendations to its console, for IT.
11. **Remember**: store the answer for idempotent retries.
12. **Close**: one `replied` audit line with the API outcome the caller received, on every path.

## Reading order for a first-time reader

1. `README.md`: what it is and the safety promises.
2. `src/contracts/types.ts`: the data shapes. `ProblemReport` has 8 fields and no decision field.
3. `src/contracts/adapters.ts`: the adapter method lists. No update method exists.
4. `src/decide.ts`: the whole decision, about 40 lines of logic.
5. `src/clusterGate.ts`: correlation keys, thresholds, the window.
6. `src/floodLedger.ts`: parents, child reporters, the per-key queue.
7. `src/priorityPolicy.ts` with `policy.example.yaml`, then `src/frustration.ts`.
8. `src/orchestrator.ts`: steps 1–11 above, in order.
9. `src/parser/llmParser.ts` and `src/parser/fieldRules.ts`, then `src/parser/reportParser.ts` and `src/parser/keywordExtractor.ts`.
10. `src/parser/router.ts`, `src/parser/specialist.ts`, `src/parser/features.ts`: the stage-2 specialist path.
11. `training/train.py` with `training/templates.json` and `scripts/buildTrainingSet.ts`: how the specialists are made.
12. `src/correlate.ts`, then its two adapters: `src/patternDetector.ts` and `src/alertAdapter.ts`.
13. `src/adapters/servicenow.ts`: the only code that talks to ServiceNow.
14. `src/composition.ts`: how it is wired, and which environment variables matter.
15. Tests to read first: `tests/floodControl.test.ts`, `tests/specialistParity.test.ts`, `tests/router.test.ts`, `tests/alertContract.test.ts`.
16. `docs/DECISIONS.md`, `docs/RESULTS.md`, `docs/LEARNINGS.md`.

Many comments in `src/` cite design notes by file name (`cluster_gate.md`,
`error_rescue_map.md`, `boundaries.md` and 30 others). Those notes were never
committed to this repository, so the comment around each citation is the
explanation; the code and its tests are the source of truth.
