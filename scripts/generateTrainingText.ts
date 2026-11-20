// `npm run generate:training-text` — asks Claude Haiku 5.5 to write SYNTHETIC
// campus IT reports for every valid label combination in training/templates.json,
// and writes them to data/train/haiku.jsonl. Live network call; run once, commit
// the output; never part of `npm test`.
//
// The labels of each row are the ones REQUESTED, never read back from the text
// (docs/DECISIONS.md M2-Q7). No row of tests/corpus.ts or data/handwritten/ is
// ever sent as an example. Buildings come from the fictional vocabulary.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import Anthropic from '@anthropic-ai/sdk';

import { PARSER_MODEL } from '../src/parser/llmParser';
import { AREA_TOKENS, BUILDINGS } from '../src/vocab/locations';

const OUTPUT = 'data/train/haiku.jsonl';
const MESSAGES_PER_CALL = 4;

type Valid = Record<string, { scopes: string[]; symptoms: string[] }>;
const { valid } = JSON.parse(readFileSync('training/templates.json', 'utf8')) as { valid: Valid };

const SYSTEM =
  'You write SYNTHETIC test data for a campus IT help-desk tool. Write short messages that a student, ' +
  'instructor or staff member might type into an IT problem form: plain everyday language, one or two ' +
  'sentences, each message worded differently. Never include names of people, email addresses or phone ' +
  'numbers. Never mention any campus building or place except the one you are given, if any. ' +
  `Call record_messages once with exactly ${MESSAGES_PER_CALL} messages.`;

const TOOL: Anthropic.Tool = {
  name: 'record_messages',
  description: 'Record the generated messages.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['messages'],
    properties: { messages: { type: 'array', items: { type: 'string' } } },
  },
};

const SERVICE: Record<string, string> = {
  wifi: 'the campus Wi-Fi / wireless network',
  wired_network: 'a wired ethernet connection or network wall jack',
  vpn: 'the campus VPN',
  web_portal: 'a campus website or web portal (a learning platform, registration, housing or library site)',
  classroom_av: 'classroom audio-visual equipment such as a projector, display or document camera',
  unknown: 'their internet or network connection in general, WITHOUT saying whether it is Wi-Fi or wired',
};
const SYMPTOM: Record<string, string> = {
  no_connection: 'it cannot connect at all',
  intermittent: 'the connection keeps dropping in and out',
  slow: 'it works but is very slow',
  page_error: 'a page shows an error or will not load',
  auth_failure: 'signing in fails, loops, or keeps asking for the password',
  equipment_unavailable: 'the equipment will not turn on or shows no image',
  unknown: 'something is wrong, WITHOUT describing any specific symptom',
};

const PLACES = [...BUILDINGS.map((b) => b.name), ...AREA_TOKENS];

function scopeInstruction(scope: string, place: string): string {
  if (scope === 'location') return `Everyone in one place is affected. Mention the place by exactly this name: "${place}".`;
  if (scope === 'individual') return 'Only the writer\'s own device or account is affected; make that clear. Do not mention any building or place.';
  if (scope === 'service_wide') return 'Everyone across the whole campus is affected; make that clear. Do not mention any building or place.';
  return 'Do not say whether anyone else is affected, and do not mention any building or place.';
}

type Batch = { id: string; service: string; scope: string; symptom: string; frustrated: boolean; place: string };

function batches(): Batch[] {
  const out: Batch[] = [];
  for (const [service, { scopes, symptoms }] of Object.entries(valid)) {
    for (const scope of scopes) {
      for (const symptom of symptoms) {
        for (const frustrated of [false, true]) {
          // Deterministic, label-independent place choice: cycle through the list.
          const place = scope === 'location' ? PLACES[out.length % PLACES.length] : '';
          out.push({ id: `haiku-${service}-${scope}-${symptom}-${frustrated ? 'frustrated' : 'calm'}`, service, scope, symptom, frustrated, place });
        }
      }
    }
  }
  return out;
}

async function generate(client: Anthropic, batch: Batch): Promise<string[]> {
  const request =
    `Topic: ${SERVICE[batch.service]}.\nProblem: ${SYMPTOM[batch.symptom]}.\n` +
    `Who is affected: ${scopeInstruction(batch.scope, batch.place)}\n` +
    `Tone: ${batch.frustrated ? 'the writer is frustrated; the problem keeps happening and they are annoyed.' : 'the writer is calm and polite.'}`;
  const message = await client.messages.create({
    model: PARSER_MODEL,
    max_tokens: 1024,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: TOOL.name },
    messages: [{ role: 'user', content: request }],
  });
  const call = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  const texts = (call?.input as { messages?: unknown } | undefined)?.messages;
  if (message.stop_reason !== 'tool_use' || !Array.isArray(texts)) throw new Error(`no messages for ${batch.id}`);
  return texts
    .filter((t): t is string => typeof t === 'string' && t.trim() !== '' && !t.includes('@'))
    .slice(0, MESSAGES_PER_CALL);
}

async function main(): Promise<number> {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    process.stderr.write('Set ANTHROPIC_API_KEY to generate training text.\n');
    return 1;
  }
  const client = new Anthropic({ maxRetries: 3 });
  const all = batches();
  const rows: string[] = [];
  // Four calls at a time: polite to the API, still a few minutes end to end.
  for (let i = 0; i < all.length; i += 4) {
    const chunk = all.slice(i, i + 4);
    const results = await Promise.all(chunk.map((b) => generate(client, b)));
    chunk.forEach((batch, j) => {
      for (const text of results[j]) {
        rows.push(JSON.stringify({ text: text.trim(), service: batch.service, scope: batch.scope, symptom: batch.symptom, frustrated: batch.frustrated, place: batch.place, batch: batch.id }));
      }
    });
    process.stdout.write(`${Math.min(i + 4, all.length)}/${all.length} batches\n`);
  }
  const meta = {
    _meta: {
      note: 'SYNTHETIC training text written by Claude Haiku 5.5. Labels are the requested ones, not read back from the text.',
      model: PARSER_MODEL,
      generatedAt: new Date().toISOString(),
      system: SYSTEM,
      promptSha256: createHash('sha256').update(SYSTEM + JSON.stringify([SERVICE, SYMPTOM])).digest('hex'),
      batches: all.length,
    },
  };
  writeFileSync(OUTPUT, [JSON.stringify(meta), ...rows].join('\n') + '\n');
  process.stdout.write(`Wrote ${rows.length} rows to ${OUTPUT}\n`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`generation failed: ${error instanceof Anthropic.APIError ? `HTTP ${error.status}` : String(error)}\n`);
    process.exit(1);
  },
);
