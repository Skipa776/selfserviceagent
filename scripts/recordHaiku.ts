// `npm run record:haiku` — the ONE script that refreshes the parser's recorded
// responses. Live network call; needs ANTHROPIC_API_KEY; never part of `npm test`.
//
// 1. Confirms the model id with the Models API (fails loudly if it is unknown).
// 2. Runs the real parser over every synthetic corpus input, capturing each raw
//    Messages API response at the CreateMessage seam (repairs included).
// 3. Writes tests/fixtures/haiku-5-5.json with "recorded": true. The offline
//    tests then replay those exact responses.
//
// Recording is a measurement: note the date and commit in docs/RESULTS.md.

import { writeFile } from 'node:fs/promises';

import Anthropic from '@anthropic-ai/sdk';
import { VERSION } from '@anthropic-ai/sdk/version';

import { createLlmParser, createMessageFromEnv, PARSER_MODEL } from '../src/parser/llmParser';
import { EVAL_ROWS } from '../tests/corpus';
import { RECORDED_FIXTURE_PATH, type RecordedExchange, type RecordedFixture } from '../tests/llmFixtures';

async function main(): Promise<number> {
  const live = createMessageFromEnv();
  if (live === null) {
    process.stderr.write('Set ANTHROPIC_API_KEY to record Haiku responses.\n');
    return 1;
  }

  const info = await new Anthropic().models.retrieve(PARSER_MODEL);
  process.stdout.write(`Models API: ${info.id} (${info.display_name})\n`);

  const exchanges: RecordedExchange[] = [];
  for (const row of EVAL_ROWS) {
    const responses: Anthropic.Message[] = [];
    const parser = createLlmParser({
      createMessage: async (params) => {
        const message = await live(params);
        responses.push(message);
        return message;
      },
      now: () => new Date(),
    });
    const parsed = await parser.parse(row.input);
    exchanges.push({ input: row.input, responses, parsed });
    process.stdout.write(`${parsed.source.padEnd(7)} ${row.id}\n`);
  }

  const fixture: RecordedFixture = {
    recorded: true,
    note: 'Recorded from the live Anthropic API by scripts/recordHaiku.ts. Inputs are the SYNTHETIC corpus in tests/corpus.ts.',
    model: PARSER_MODEL,
    modelInfo: { id: info.id, display_name: info.display_name },
    recordedAt: new Date().toISOString(),
    sdkVersion: VERSION,
    exchanges,
  };
  await writeFile(RECORDED_FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  process.stdout.write(`Wrote ${exchanges.length} exchanges to ${RECORDED_FIXTURE_PATH}\n`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    // Status only, never the provider body.
    process.stderr.write(`record failed: ${error instanceof Anthropic.APIError ? `HTTP ${error.status}` : 'unknown error'}\n`);
    process.exit(1);
  },
);
