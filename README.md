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
  -> parser: Claude Haiku 5.5 (forced tool), or the keyword parser with no key
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

Then open <http://127.0.0.1:4000/>. Optional settings go in `.env` (copy
`.env.example`): `ANTHROPIC_API_KEY` turns on the Claude parser;
`REPORTER_HASH_SALT` is required when ServiceNow is configured;
`PRIORITY_POLICY_PATH` points to a real policy kept outside the repo. ServiceNow
PDI setup, the HTTP API, the analyst demo and every script: [docs/SETUP.md](docs/SETUP.md).

## Current Results

All data is synthetic; nothing here describes real campus traffic. Details,
commands and hardware: [docs/RESULTS.md](docs/RESULTS.md).

- 30 same-problem reports from 30 reporters, fired concurrently: **1 INC created**, 29 linked locally, ledger count 30, one pending recommendation (P4 → P2, rule `t2-reporters-15`).
- 7 scripted scenarios, 132 reports: **16 creates** instead of 132, **0 false merges**, 1 missed merge (an outage that outlasts the fixed link window).
- Keyword parser on the 26-row synthetic corpus: 137/156 fields (87.8%).
- Claude Haiku 5.5: **not measured yet**. The offline fixture is a SYNTHETIC placeholder until `npm run record:haiku` runs with a key.

## Known Limits

- Single-process local demonstration. The flood ledger, throttle, idempotency
  and overrides live in memory; a restart mid-flood opens a second parent.
- The link window is fixed from the parent's creation, so a long outage gets a
  second incident, and a parent IT closes inside the window still absorbs reports.
- Reports for one problem are processed one at a time, ServiceNow search included.
- The frustration signal is a keyword placeholder, not validated against people.
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
