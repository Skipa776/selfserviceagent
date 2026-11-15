// Test doubles for the Anthropic parser, plus the recorded-response fixture.
//
// Not a test file. Automated tests exercise the LLM path against canned
// responses, never a live API, for three reasons: the suite stays free and fast,
// it stays deterministic, and it stays runnable with NO credentials.
//
// Two kinds of canned response live here, and they are kept apart on purpose:
//   - toolUseMessage() & co. are HAND-BUILT test doubles in the exact Messages
//     API shape. They exist to drive failure modes (invalid fields, refusals,
//     no tool call) that a real recording cannot produce on demand.
//   - tests/fixtures/haiku-5-5.json holds responses for real corpus inputs.
//     `npm run record:haiku` fills it from the live API; until that has been run
//     it is marked SYNTHETIC (see its "recorded" field).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type Anthropic from '@anthropic-ai/sdk';

import type { CreateMessage } from '../src/parser/llmParser';
import type { ParseResult } from '../src/orchestrator';

const BASE = {
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-5-5',
  container: null,
  diagnostics: null,
  stop_sequence: null,
  stop_details: null,
  usage: {
    input_tokens: 1200,
    output_tokens: 60,
    cache_creation: null,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    inference_geo: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: 'standard',
    speed: 'standard',
  },
} as const;

let nextId = 0;

/** A forced-tool response whose tool input is `input`. SYNTHETIC test double. */
export function toolUseMessage(input: Record<string, unknown>): Anthropic.Message {
  nextId++;
  return {
    ...BASE,
    id: `msg_synthetic_${nextId}`,
    stop_reason: 'tool_use',
    content: [
      { type: 'tool_use', id: `toolu_synthetic_${nextId}`, name: 'record_report_fields', input, caller: { type: 'direct' } },
    ],
  } as Anthropic.Message;
}

/** The safety classifier declined. No tool call, nothing to repair. */
export function refusalMessage(): Anthropic.Message {
  return { ...BASE, id: 'msg_synthetic_refusal', stop_reason: 'refusal', content: [] } as unknown as Anthropic.Message;
}

/** The model answered in prose instead of calling the tool. */
export function proseMessage(): Anthropic.Message {
  return {
    ...BASE,
    id: 'msg_synthetic_prose',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'It sounds like the wifi is unstable. Try reconnecting.', citations: null }],
  } as unknown as Anthropic.Message;
}

/** A conforming record for TEXT = 'wifi in North Residence Hall keeps dropping'. */
export const CLEAN = {
  service: 'wifi',
  scope: 'location',
  location: 'North Residence Hall',
  building: 'NORTH RESIDENCE HALL',
  room: '',
  symptom: 'intermittent',
  observedAt: '',
} as const;

export const PROJECTOR = {
  service: 'classroom_av',
  scope: 'location',
  location: 'Lecture Hall',
  building: 'LECT',
  room: '',
  symptom: 'equipment_unavailable',
  observedAt: '',
} as const;

/** Passes the API's schema check but fails ours: the location/building pair is wrong. */
export const MISMATCHED_BUILDING = { ...CLEAN, building: 'LECT' } as const;

/** 'WiFi' is not a catalog value (the API's strict mode would block this; our validator must too). */
export const OUT_OF_VOCABULARY = { ...CLEAN, service: 'WiFi' } as const;

/** Missing a required field. */
export const MISSING_FIELD: Record<string, unknown> = { ...CLEAN };
delete MISSING_FIELD.symptom;

/**
 * The model volunteers a field it was never asked for, paraphrasing the
 * reporter. If this reached a ticket body, model prose would sit in front of an
 * IT agent as though the reporter wrote it.
 */
export const MODEL_SUPPLIED_VERBATIM_TEXT = 'User reports intermittent wireless connectivity in North Residence Hall.';
export const MODEL_SUPPLIED_VERBATIM = { ...CLEAN, verbatim: MODEL_SUPPLIED_VERBATIM_TEXT };

export type FakeCreateMessage = CreateMessage & {
  /** Every request the parser sent, in order. The repair bound is asserted on this. */
  readonly calls: Anthropic.MessageCreateParamsNonStreaming[];
};

/**
 * Replays `responses` in order, one per call. A `null` entry throws instead —
 * that is how a timeout or a 500 is induced. Running past the end throws too:
 * a test that expects two calls and gets three fails loudly.
 */
export function fakeCreateMessage(...responses: readonly (Anthropic.Message | null)[]): FakeCreateMessage {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const fake = async (params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> => {
    const i = calls.length;
    calls.push(params);
    const response = responses[i];
    if (response === undefined) throw new Error(`fake createMessage: unexpected call #${i + 1}`);
    if (response === null) throw new Error('fake createMessage: induced API failure');
    return response;
  };
  return Object.assign(fake, { calls });
}

// ── The recorded fixture ──────────────────────────────────────────────────────

export type RecordedExchange = {
  /** The report text sent as the user message. */
  readonly input: string;
  /** Every response the parser received for it, in call order (2 if it repaired). */
  readonly responses: readonly Anthropic.Message[];
  /** What the parser produced from those responses when they were recorded. */
  readonly parsed: ParseResult;
};

export type RecordedFixture = {
  /** false until `npm run record:haiku` has replaced the hand-built entries. */
  readonly recorded: boolean;
  readonly note: string;
  readonly model: string;
  /** From the Models API at record time: confirms the model id exists. */
  readonly modelInfo: { readonly id: string; readonly display_name: string } | null;
  readonly recordedAt: string;
  readonly sdkVersion: string;
  readonly exchanges: readonly RecordedExchange[];
};

export const RECORDED_FIXTURE_PATH = fileURLToPath(new URL('./fixtures/haiku-5-5.json', import.meta.url));

export function loadRecordedFixture(): RecordedFixture {
  return JSON.parse(readFileSync(RECORDED_FIXTURE_PATH, 'utf8')) as RecordedFixture;
}

/** A CreateMessage that answers each input with its recorded responses, in order. */
export function replayRecorded(fixture: RecordedFixture): CreateMessage {
  const callsByInput = new Map<string, number>();
  return async (params) => {
    const first = params.messages[0]?.content;
    const input = typeof first === 'string' ? first : '';
    const exchange = fixture.exchanges.find((e) => e.input === input);
    if (exchange === undefined) throw new Error(`no recorded response for: ${input}`);
    const n = callsByInput.get(input) ?? 0;
    callsByInput.set(input, n + 1);
    const response = exchange.responses[n];
    if (response === undefined) throw new Error(`recorded fixture has no call #${n + 1} for: ${input}`);
    return response;
  };
}
