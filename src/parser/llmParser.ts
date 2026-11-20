// Stage-2 structured parser: Claude Haiku 5.5 through the Anthropic SDK, with a
// forced tool call. Model output is untrusted until strict validation;
// normalization remains a separate downstream safety boundary.
//
// Why a forced tool and not "reply with JSON": the API hands back the tool input
// as an object that already matches the schema's types and enums (`strict:
// true`), so there is no JSON to dig out of prose or code fences. What a schema
// cannot express (location/building pairs, scope vs location) is still checked
// by validateAgainstSchema() (fieldRules.ts), with one repair turn.

import Anthropic from '@anthropic-ai/sdk';

import type { ParseResult } from '../orchestrator';
import { SCOPES, SERVICES, SYMPTOMS } from '../vocab/catalog';
import { MODEL_FIELDS, validateAgainstSchema } from './fieldRules';
import { normalize, parseReport, VERBATIM_MAX_LEN } from './reportParser';
import { canonicalBuilding, canonicalLocation, canonicalRoom } from '../vocab/locations';

/** The parser model. Confirmed against the Models API by `npm run record:haiku`. */
export const PARSER_MODEL = 'claude-haiku-5-5';

/**
 * The single SDK call the parser makes. Injected so tests replay recorded
 * responses without a network or a mocked SDK.
 */
export type CreateMessage = (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;

export type LlmParserDeps = {
  readonly createMessage: CreateMessage;
  /** Injected for deterministic future-timestamp normalization. */
  readonly now: () => Date;
};

/**
 * Builds the closed model-output schema directly from the canonical catalogs.
 * `additionalProperties: false` and omission of `verbatim` prevent unsolicited
 * model fields or model-authored reporter prose from entering the contract.
 */
export function schemaFromCatalog(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: [...MODEL_FIELDS],
    properties: {
      service: { type: 'string', enum: [...SERVICES] },
      scope: { type: 'string', enum: [...SCOPES] },
      symptom: { type: 'string', enum: [...SYMPTOMS] },
      location: { type: 'string' },
      building: { type: 'string' },
      room: { type: 'string' },
      observedAt: { type: 'string' },
    },
  };
}

/** The one tool the model may call. The schema is the catalog, not a copy of it. */
export const REPORT_TOOL: Anthropic.Tool = {
  name: 'record_report_fields',
  description: 'Record the structured fields of one campus IT problem report.',
  strict: true,
  input_schema: schemaFromCatalog() as Anthropic.Tool.InputSchema,
};

/**
 * Extraction policy lives in the system prompt; the reporter's untrusted text is
 * the only user message. Ambiguous fields stay unknown.
 */
export const SYSTEM_PROMPT =
  'You are extracting structured fields from a campus IT problem report. ' +
  `Do not diagnose, advise, or decide anything. Call ${REPORT_TOOL.name} exactly once. ` +
  "For service, scope, and symptom, use the exact catalog value or 'unknown'. " +
  "For location, building, room, and observedAt, use '' when the report does not establish " +
  "the value; never use 'unknown' for those four fields. Keep location as the canonical " +
  'display name, building as the canonical building code, and room as a separate room token. ' +
  'Do not guess the nearest building. A roomless building-level classroom AV report is valid. ' +
  'Scope is role-neutral: student, faculty, staff, and first-person wording alone do not ' +
  'establish individual scope. Explicit personal-device or only-me wording supports individual; ' +
  'named shared building or room impact supports location; explicit campus-wide breadth ' +
  'supports service_wide; ambiguity stays unknown. Use this compact taxonomy: ' +
  'page/load/error/blank web page or portal language -> web_portal + page_error; sign-in loops ' +
  'or repeated prompts -> auth_failure; will not connect, cannot connect, or no image/network -> ' +
  'no_connection unless the subject is a projector/display, which is classroom_av + ' +
  'equipment_unavailable; cutting out/on and off -> intermittent; slow/crawling -> slow. A network ' +
  'jack, ethernet, LAN, or wired network -> wired_network. Explicit wifi, Wi-Fi, wireless, or ' +
  'eduroam -> wifi. Generic internet or internet access without wifi/wireless or wired evidence ' +
  '-> unknown service, never guess wifi. VPN maps to vpn. Scope: "my laptop"/"only me"/"my login" ' +
  'plus a contrast such as someone else works -> individual; for VPN, a personal login/sign-in ' +
  'loop or repeated prompt is individual unless nobody/everyone is affected; a named ' +
  'building/room or "around/in" a place -> location; nobody, everyone, anywhere, or campus-wide ' +
  'breadth -> service_wide; generic portal failure and role words alone remain unknown. For ' +
  "observedAt, use ISO-8601 only if the report states a time; otherwise use ''. Never use 'now' " +
  'or infer a time from tense. Representative canonical examples: ' +
  JSON.stringify([
    { service: 'wifi', scope: 'location', location: 'North Residence Hall', building: 'NORTH RESIDENCE HALL', room: '', symptom: 'intermittent', observedAt: '' },
    { service: 'classroom_av', scope: 'location', location: 'Lecture Hall', building: 'LECT', room: '214', symptom: 'equipment_unavailable', observedAt: '' },
    { service: 'web_portal', scope: 'unknown', location: '', building: '', room: '', symptom: 'page_error', observedAt: '' },
    { service: 'unknown', scope: 'location', location: 'Main Library', building: 'LIB', room: '', symptom: 'slow', observedAt: '' },
    { service: 'wired_network', scope: 'location', location: 'Student Center', building: 'STUC', room: '', symptom: 'no_connection', observedAt: '' },
    { service: 'vpn', scope: 'individual', location: '', building: '', room: '', symptom: 'auth_failure', observedAt: '' },
  ]) +
  '.';

/**
 * Every request is the same apart from the conversation. No temperature: Haiku
 * 5.5 rejects non-default sampling values. No thinking setting: a forced tool
 * call skips thinking on this model.
 */
export function buildRequest(messages: Anthropic.MessageParam[]): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: PARSER_MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: [REPORT_TOOL],
    tool_choice: { type: 'tool', name: REPORT_TOOL.name },
    messages,
  };
}

/**
 * The live SDK call, or null when ANTHROPIC_API_KEY is unset — null wires the
 * keyword parser, so a clean clone with no `.env` still runs.
 */
export function createMessageFromEnv(env: NodeJS.ProcessEnv = process.env): CreateMessage | null {
  if (!env.ANTHROPIC_API_KEY?.trim()) return null;
  // A hung parse must become a keyword parse quickly: the reporter is waiting.
  // No SDK retries, for the same reason (the old fetch client had none either).
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 10_000, maxRetries: 0 });
  return (params) => client.messages.create(params);
}

/**
 * The tool call from a response. A refusal or a max_tokens cut can leave a
 * partial tool input, so anything but stop_reason 'tool_use' is a failure.
 */
function toolCall(message: Anthropic.Message): Anthropic.ToolUseBlock {
  if (message.stop_reason !== 'tool_use') throw new Error(`llm stop_reason ${message.stop_reason}`);
  const call = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use' && block.name === REPORT_TOOL.name,
  );
  if (call === undefined) throw new Error('llm returned no tool call');
  return call;
}

/**
 * Converts only known catalog aliases to canonical location fields. This is
 * deterministic and lossless for the location vocabulary; it avoids spending
 * the one model repair on casing, display-name, or room-token differences.
 */
function canonicalizeLocationFields(candidate: unknown): unknown {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return candidate;
  const record = candidate as Record<string, unknown>;
  const location = canonicalLocation(record.location) || (record.location === '' ? '' : record.location);
  // An exact canonical location with an empty building code: the code follows by
  // table lookup, so fill it rather than spend the repair (measured: Haiku 5.5 did
  // this twice in a row for "Hillside Academic Building"). A building that
  // contradicts the location is left alone and still fails validation.
  const fillBuilding = record.building === '' && record.location !== '' && record.location === canonicalLocation(record.location);
  return {
    ...record,
    location,
    building: fillBuilding
      ? canonicalBuilding(location)
      : canonicalBuilding(record.building) || (record.building === '' ? '' : record.building),
    room: canonicalRoom(record.room) || (record.room === '' ? '' : record.room),
  };
}

/**
 * Calls once, validates, then makes exactly one repair attempt: the error goes
 * back as an `is_error` tool result. The telemetry flag is set before that call
 * so failures still record the attempt.
 */
async function parseWithModel(text: string, deps: LlmParserDeps, telemetry: RepairTelemetry): Promise<unknown> {
  // The same 2,000-character cap as the stored verbatim text and the specialists:
  // the endpoint accepts 64 KB, and the model never needs more than we keep.
  const conversation: Anthropic.MessageParam[] = [{ role: 'user', content: text.slice(0, VERBATIM_MAX_LEN) }];
  const first = await deps.createMessage(buildRequest(conversation));
  const call = toolCall(first);
  const candidate = canonicalizeLocationFields(call.input);
  const error = validateAgainstSchema(candidate);
  if (error === null) return candidate;

  telemetry.repairAttempted = true;
  const second = await deps.createMessage(
    buildRequest([
      ...conversation,
      { role: 'assistant', content: first.content },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: call.id,
            is_error: true,
            content: `ERROR: ${error}. Call ${REPORT_TOOL.name} again with corrected fields.`,
          },
        ],
      },
    ]),
  );
  const repaired = canonicalizeLocationFields(toolCall(second).input);
  if (validateAgainstSchema(repaired) === null) return repaired;

  throw new Error('llm parser: repair failed');
}

/** Mutable handle preserves repair telemetry when the model call throws. */
type RepairTelemetry = { repairAttempted: boolean };

/**
 * Returns normalized model output or a deterministic fallback; model failures
 * (no key, network, refusal, invalid twice) degrade parsing quality, never
 * endpoint availability.
 */
export function createLlmParser(deps: LlmParserDeps): { parse(text: string): Promise<ParseResult> } {
  return {
    async parse(text: string): Promise<ParseResult> {
      const telemetry: RepairTelemetry = { repairAttempted: false };
      try {
        const record = (await parseWithModel(text, deps, telemetry)) as Record<string, unknown>;
        return {
          // Verbatim always comes from the original report, never model output.
          report: normalize({ ...record, verbatim: text }, deps.now()),
          source: 'llm',
          repairAttempted: telemetry.repairAttempted,
        };
      } catch {
        // Provider errors may echo request text, so they do not cross into logs.
        return { report: parseReport(text), source: 'keyword', repairAttempted: telemetry.repairAttempted };
      }
    },
  };
}
