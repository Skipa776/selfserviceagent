# Setup and operation

Detailed setup, moved from the README. Everything here is for local
development with synthetic data.

## Project Status

This repository is a contained local-development project, not a production
university service.

The complete ServiceNow demonstration requires either:

- Access to an institutional ServiceNow REST Table API with approved credentials
  and fields, or
- A ServiceNow Personal Developer Instance (PDI) configured as described below.

AI parsing requires an Anthropic API key (`ANTHROPIC_API_KEY`); the parser
uses Claude Haiku 5.5.

Without AI credentials, the normal application still starts and falls back to a
deterministic keyword parser. Without ServiceNow credentials, it uses an in-memory
ticket sink. Always run `npm run snow:check` before claiming a ticket was created
in ServiceNow.

## Requirements

- Node.js 24.x
- npm
- Optional `ANTHROPIC_API_KEY` (report parser)
- Optional OpenAI-compatible credentials (experimental analyst proposal model only)
- Optional ServiceNow PDI or approved institutional ServiceNow Table API access

## Install

```bash
git clone <repository-url>
cd selfserviceagent
npm ci
cp .env.example .env
```

`npm ci`, the test suite, and the offline demo do not require gstack or any other
agent tooling.

## Environment

Edit `.env` and provide only the integrations you want to exercise.

### AI Parser

```dotenv
ANTHROPIC_API_KEY=replace-with-your-key
```

The report parser calls Claude Haiku 5.5 (`claude-haiku-5-5`) through the
Anthropic SDK with one forced, strict tool. Without the key, every report is
parsed by the deterministic keyword parser and the audit log says
`parseSource: 'keyword'`.

### Identity salt and priority policy

```dotenv
REPORTER_HASH_SALT=generate-with-openssl-rand-hex-32
# PRIORITY_POLICY_PATH=/path/outside/the/repo/priority-policy.yaml
```

`REPORTER_HASH_SALT` is required when ServiceNow is configured. Without
ServiceNow, a random per-process salt is used. `PRIORITY_POLICY_PATH` points to
a real priority policy kept outside the repository; unset, the synthetic
`policy.example.yaml` is used.

### Analyst proposal model (experimental)

```dotenv
LLM_API_URL=https://your-provider.example/v1
LLM_API_KEY=replace-with-your-api-key
LLM_MODEL=a-flash-class-model
```

Only the experimental analyst proposal model uses these. It needs an
OpenAI-compatible `/chat/completions` endpoint with bearer authentication.

### ServiceNow

```dotenv
SNOW_INSTANCE_URL=https://dev000000.service-now.com
SNOW_USER=admin
SNOW_PASSWORD=replace-with-your-pdi-password
SNOW_READ_SCOPE=service_owned
SNOW_TIMEOUT_MS=15000
```

Use the instance origin only, with no trailing path. The local PDI demo uses Basic
authentication over HTTPS. Production authentication and least-privilege
roles require separate approval and configuration.

Never commit `.env` or real credentials.

The complete annotated template is in [`.env.example`](.env.example).

## ServiceNow PDI Setup

Create these five optional String columns on the existing global `Task [task]`
table. Do not create a new table. `incident` and `sc_request` inherit the fields.

| Label | Exact column name | Type | Max length |
| --- | --- | --- | ---: |
| Campus Issue Service | `u_service` | String | 40 |
| Campus Issue Scope | `u_scope` | String | 40 |
| Campus Issue Symptom | `u_symptom` | String | 80 |
| Campus Issue Location | `u_location` | String | 255 |
| Campus Issue Reporter Hash | `u_reporter_hash` | String | 64 |

Leave each field non-mandatory, non-unique, writable, and without a default.

Verify the instance and fields:

```bash
npm run snow:check
```

This preflight reads `sys_dictionary`. A least-privilege account may be able to
create incidents but unable to inspect dictionary metadata; use an administrator
for PDI setup or have the ServiceNow owner verify the fields and ACLs.

The ServiceNow adapter uses the REST Table API:

```text
GET  /api/now/table/incident   search active peer incidents
GET  /api/now/table/sc_request search active peer requests
POST /api/now/table/incident   create an incident
POST /api/now/table/sc_request create an individual request by default
```

Created records use `correlation_display=campus-issue-reporter` so the default
`service_owned` read scope searches only records owned by this integration.

## Run The Application

### Offline CLI Demo

No credentials or network required:

```bash
npm run demo
```

### Web Application

```bash
npm run web
```

Open <http://127.0.0.1:4000/>.

The normal web app keeps one synthetic reporter identity per page load. This is a
local stand-in for authenticated campus identity.

### Presentation Mode

```bash
npm run web:presentation
```

Presentation mode rotates a clearly labelled synthetic reporter after each
accepted submission so one presenter can demonstrate the distinct-reporter
threshold from a single browser. Never use this mode as production identity.

Suggested Lecture Hall sequence with a configured, evaluated AI model:

1. `The projector in Lecture Hall will not turn on`
2. `The display equipment in Lecture Hall will not power on`
3. `Projectors across Lecture Hall are not turning on`
4. `Faculty reports that the AV equipment in Lecture Hall is unavailable`

The first report creates the parent incident. The next three return
`MATCHED_CLUSTER`, link to it in the local flood ledger, and create nothing.
Select **This is not my issue - file separately** to verify the override path.

Without AI credentials, use the same supported phrase for each submission, such
as `The projector in Lecture Hall will not turn on`, because the keyword fallback
intentionally recognizes fewer paraphrases.

Inspect matching ServiceNow records:

```bash
SNOW_CHECK_SERVICE=classroom_av \
SNOW_CHECK_SCOPE=location \
SNOW_CHECK_SYMPTOM=equipment_unavailable \
SNOW_CHECK_LOCATION="Lecture Hall" \
npm run snow:peers
```

### Experimental Analyst Demo

The analyst surface compares parser models, aggregates synthetic report evidence,
and creates a human-approved local `SHARED-DEMO-*` record for operator review. It
is loopback-only, does not create generalized ServiceNow incidents, and does not
use local shared records to bypass the normal reporter lifecycle.

It requires the analyst proposal model's `LLM_*` credentials:

```bash
ANALYST_OPERATOR_TOKEN="$(openssl rand -hex 24)" npm run demo:analyst
```

Open:

- Reporter: <http://127.0.0.1:4100/>
- Operator login: <http://127.0.0.1:4100/operator/login>

The process prints the bootstrap operator token. It can create one active session
at a time and becomes available again after that session expires. Sessions last
30 minutes.

## Model Evaluation

Score the keyword parser (always) and Claude Haiku 5.5 (when
`ANTHROPIC_API_KEY` is set) on the synthetic corpus, or on the hand-written set:

```bash
npm run eval:llm
```

```bash
npm run eval:llm -- data/handwritten/reports.jsonl
```

Compare Claude models on the same parser request (only models that accept a
forced `tool_choice`):

```bash
ANALYST_MODELS="claude-haiku-5-5,claude-sonnet-5" LLM_EVAL_RUNS=3 npm run eval:models
```

Refresh the recorded Haiku responses the offline tests replay (also confirms
the model id with the Models API):

```bash
npm run record:haiku
```

Flood-control scenarios (offline):

```bash
npm run eval:flood
```

The generated `analyst-model-benchmark.json` is ignored by Git. A single run is
not a production model-approval decision.

## HTTP API

The local web server exposes `POST /report`:

```bash
curl http://127.0.0.1:4000/report \
  -H 'content-type: application/json' \
  -d '{
    "text": "The projector in Lecture Hall will not turn on",
    "identityRef": "synthetic-caller-1",
    "canFollowUp": true
  }'
```

Request fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `text` | string | Reporter's problem description |
| `identityRef` | string | Opaque caller identity used for hashing and throttling |
| `canFollowUp` | boolean | Whether the caller can ask for missing detail |
| `overrideMatchId` | string, optional | Existing match the reporter rejected |

Successful application outcomes return HTTP 200. Malformed, empty, or oversized
HTTP bodies return 400 with a canonical `UNAVAILABLE` response. Throttling returns
429 and an unavailable dependency returns 503. Response outcomes are
`MATCHED_DECLARED`, `MATCHED_CLUSTER`, `FILED_INCIDENT`, `FILED_REQUEST`,
`NEEDS_DETAIL`, `THROTTLED`, or `UNAVAILABLE`. Match responses include an override
handle; filed responses include the ticket number and URL returned by the ticket
sink.

## Verify

Run the complete local verification suite:

```bash
npm test
npm run build
npm run lint
npm run web:e2e
npm run demo:analyst:e2e
```

The automated tests use canned model responses (`tests/fixtures/haiku-5-5.json`,
a SYNTHETIC placeholder until `npm run record:haiku` is run) and synthetic
ServiceNow responses. They do not require credentials or network access.

Live integration checks:

```bash
npm run snow:check
npm run snow:peers
npm run snow:inspect-analyst
```

These commands require a configured and reachable ServiceNow instance.

## Project Layout

```text
src/       application core, parsers, contracts, adapters, flood ledger, priority policy
web/       local reporter application and HTTP smoke test
analyst/   local analyst UI, server, and HTTP smoke test
demo/      deterministic and interactive CLI demos
scripts/   live model and ServiceNow diagnostics
tests/     unit and integration tests with synthetic fixtures
data/      hand-written test set (placeholder until written)
docs/      decisions, architecture, results, learnings, this setup guide
policy.example.yaml   SYNTHETIC priority policy
```
