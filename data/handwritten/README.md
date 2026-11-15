# Hand-written test set (placeholder)

`reports.jsonl` is a **placeholder**. Its only line is a `_placeholder` marker,
and the evaluation refuses to score the file while that marker is there.

Replace the whole file with about 150 reports written by a person, so no model
is graded on its own writing. All of it must be synthetic: no real tickets,
names, rooms or people.

## Format

One JSON object per line (JSON Lines). No comments, no trailing commas.

```json
{"id": "hw-001", "text": "the wifi in North Residence Hall keeps dropping", "service": "wifi", "scope": "location", "location": "North Residence Hall", "building": "NORTH RESIDENCE HALL", "room": "", "symptom": "intermittent", "frustrated": false}
{"id": "hw-002", "text": "my laptop is the only one that can't get on the VPN", "service": "vpn", "scope": "individual", "location": "", "building": "", "room": "", "symptom": "no_connection"}
```

| Field | Required | Values |
| --- | --- | --- |
| `id` | yes | unique string |
| `text` | yes | the report, exactly as a person would type it |
| `service` | yes | `wifi`, `wired_network`, `vpn`, `web_portal`, `classroom_av`, `unknown`, or an array of these when more than one answer is genuinely acceptable |
| `scope` | yes | `individual`, `location`, `service_wide`, `unknown` |
| `location` | yes | canonical location name from `src/vocab/locations.ts`, or `""` |
| `building` | yes | canonical building code from `src/vocab/locations.ts`, or `""` |
| `room` | yes | room token such as `"214"`, or `""` |
| `symptom` | yes | `no_connection`, `intermittent`, `slow`, `page_error`, `auth_failure`, `equipment_unavailable`, `unknown` |
| `frustrated` | no | `true` or `false`; the label Milestone 2's score model is graded against |
| `groupId` | no | rows with the same `groupId` describe the same problem; defaults to `id` |

Six fields are graded per row: service, scope, location, building, room,
symptom (`tests/grade.ts`). Use `unknown` or `""` when the text truly does not
say; the parser is supposed to leave those blank rather than guess.

## Run it

```bash
npm run eval:llm -- data/handwritten/reports.jsonl
```

Without `ANTHROPIC_API_KEY` this scores the keyword parser only.
