# Campus Issue Reporter

A local-development service that turns plain-language campus technology reports
into structured ServiceNow tickets and reduces duplicate incidents when several
people report the same problem.

The service uses a language model only as a parser. It extracts bounded fields
such as service, scope, location, room, and symptom. Deterministic application
code validates those fields, searches ServiceNow, decides whether to create a
ticket, and composes the user response.

## What It Does

```text
Plain-language report
  -> parser: local specialist models first (stage 2); if they abstain,
     Claude Haiku 5.5 (forced tool); the keyword parser with no key
  -> schema validation and normalization
  -> identity hash, throttle
  -> flood ledger: is a parent incident for this problem already open?
  -> ServiceNow search for active similar records (read)
  -> deterministic decision: create one ticket, or link locally
```

**Flood control.** When many people report the same problem (same service and
building, or the same service campus-wide), the first report creates one parent
incident in ServiceNow. Every later report inside the window becomes a local
child: its reporter hash is added to the parent in this service's own ledger,
and nothing else is created. The reporter is told a ticket is already open and
can reject the match to file separately. Personal reports are never merged.

**Priority.** A parent incident's priority comes from a deterministic policy
table: the service's tier, the number of distinct reporters, and whether a
majority sounded frustrated (which can raise it by one level, no more). It is
set once, at create. When more reporters arrive and the table calls for a
higher priority, the ledger holds one pending recommendation, naming the policy
rule, for a person to apply. Nothing updates the ticket.

**Specialists (CDMForge).** Four small linear models (service, scope, symptom,
frustration), trained by one Python script and run in TypeScript as a dot
product, answer a report locally when they are confident and their answer passes
the same field rules a Haiku answer must pass; otherwise the report goes to Haiku.
The abstention threshold is chosen on a validation set for a 5% error bound.

**Correlation engine.** One small engine groups signals `{key, source, time,
weight}`. The ticket adapter feeds it report events (the advisory NOC alert); the
security adapter feeds it alerts from
[detection-engineering-ml](https://github.com/Skipa776/detection-engineering-ml)
and prints incident candidates, advisory only.

Supported demonstration topics: campus Wi-Fi, wired networking, VPN, web
portals, and classroom audiovisual equipment.

## Safety Boundaries

- ServiceNow access is read and create only.
- The application cannot close, resolve, update, reassign, escalate, comment on,
  acknowledge, or delete a ticket.
- Peer-report volume is not treated as an outage declaration.
- The model does not decide whether to create a ticket or generate status text.
- A failed ServiceNow search never falls through to ticket creation.
- A failed model call falls back to deterministic parsing.
- Demonstration identities and test data are synthetic.
- Current thresholds and in-process state are suitable for a demo, not production.

## Run It

Node.js 24 and npm. No credentials are needed for any of these:

```bash
npm ci
```

```bash
npm test
```

```bash
npm run demo
```

```bash
npm run web
```

Then open <http://127.0.0.1:4000/>. Triage a file of security alerts:

```bash
npm run triage:alerts -- vendor/detection-engineering-ml/alerts.synthetic.jsonl
```

Optional settings go in `.env` (copy `.env.example`): `ANTHROPIC_API_KEY` turns on the Claude parser;
`REPORTER_HASH_SALT` is required when ServiceNow is configured;
`PRIORITY_POLICY_PATH` points to a real policy kept outside the repo;
`AUDIT_LOG_PATH` keeps the audit log in a file across restarts. ServiceNow
PDI setup, the HTTP API, the analyst demo, retraining the specialists and every
script: [docs/SETUP.md](docs/SETUP.md).

## Current Results

All data is synthetic or public; nothing here describes real campus traffic.
Details, commands, hardware and caveats: [docs/RESULTS.md](docs/RESULTS.md).

- **Flood control:** 30 same-problem reports from 30 reporters, fired concurrently: 1 INC created, 29 linked locally, ledger count 30, one pending recommendation citing its policy rule. 7 scripted scenarios: 16 creates instead of 132, 0 false merges, 1 missed merge (an outage longer than the fixed window).
- **Parsers on the 26-row development set** (counts, not rates): keyword 137/156 fields; Claude Haiku 5.5 149/156 (3 runs); specialist-then-Haiku router 152.3/156 (3 runs) with 15 of 26 reports sent to Haiku. The specialist accepted 11 reports with 0 errors.
- **Specialists on 419 synthetic held-out reports:** they answer 43% of reports with 1 error among them (95% interval 0.01–3.1%); ECE ≤ 0.018. Optimistic: same generators as the training text.
- **Security alerts** (514 public-data alerts): 98 items for a human instead of 514 (20 candidates + 78 ungrouped); 18 of 21 datasets reach a candidate. Purity 1.000 is vacuous on this data; there is no false-positive rate (no benign logs).
- **Josh's hand-written test set:** not written yet, so not measured.

## Known Limits

- Single-process local demonstration. The flood ledger, throttle, idempotency
  and overrides live in memory; a restart mid-flood opens a second parent. In a
  long-running server that state, and the in-memory copy of the audit log, only grow.
- The caller supplies `identityRef` and nothing authenticates it. A caller that
  invents a new one per report escapes the throttle and inflates the distinct-reporter
  count that drives priority recommendations.
- The link window is fixed from the parent's creation, so a long outage gets a
  second incident, and a parent IT closes inside the window still absorbs reports.
- Reports for one problem are processed one at a time, ServiceNow search included.
- The specialists were trained and measured on synthetic text; their threshold
  is certified on that distribution, not on real writing.
- The frustration signal (lexical rule or model) is not validated against people,
  and the model's held-out error bound (6.8%) is above its 5% target.
- Alert triage is advisory and offline; a host with no candidate is not a clean
  bill of health.
- The priority mapping to impact/urgency assumes ServiceNow's default lookup.
- Production Caller, Assignment group, Channel, Service, Service offering, and
  Configuration item mappings are not implemented; assignment routing is out of scope.
- The demo creates `INC` for location/service-wide reports and `REQ` for
  individual reports. The deploying institution must decide whether customer
  intake should use Customer Service cases (`CS`) instead.
- Without ServiceNow credentials, tickets go to an in-memory sink with
  realistic-looking numbers. Run `npm run snow:check` before claiming a ticket
  was created in ServiceNow.
- Generalized analyst-created ServiceNow records remain disabled.
- Production hosting, SSO, monitoring, on-call ownership, kill switch, and security
  review are outside this local project.

## Docs

[Architecture](docs/ARCHITECTURE.md) · [Decisions](docs/DECISIONS.md) ·
[Results](docs/RESULTS.md) · [Learnings](docs/LEARNINGS.md) · [Setup](docs/SETUP.md)
