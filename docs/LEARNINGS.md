# Learnings

Facts from building Milestone 1: surprises, mistakes, and approaches that
failed. Newest last.

## Environment

- **The cloud container ran Node 22, not 24.** `package.json` says `24.x`, but `npm` only warns. Node 24.22.3 came from the npm registry's `node@24` package, installed into a side prefix. The existing 447 tests passed on both versions before any change.
- **No way to give this session an Anthropic key.** The cloud credential form refuses Anthropic hosts ("authenticated by the session itself"). That authentication covers Claude Code's own calls, not project code, and using it for the project would be wrong. `api.anthropic.com` answered 401 to a dummy key. Result: no live Haiku call this session, a SYNTHETIC placeholder fixture, and a one-command recording step for Josh.
- **`docs/` was gitignored.** The original `.gitignore` excluded "local project history and planning material", including `docs/`. Writing the requested docs needed that line removed.
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
