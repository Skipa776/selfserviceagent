// Stage-2 structured parser. Model output is untrusted until strict validation;
// normalization remains a separate downstream safety boundary.

import type { ParseResult } from '../orchestrator';
import { SCOPES, SERVICES, SYMPTOMS } from '../vocab/catalog';
import type { ChatClient, ChatMessage } from './chatClient';
import { normalize, parseReport } from './reportParser';
import { canonicalBuilding, canonicalLocation, canonicalRoom } from '../vocab/locations';

export type LlmParserDeps = {
  readonly client: ChatClient;
  /** Injected for deterministic future-timestamp normalization. */
  readonly now: () => Date;
};

/** The seven fields we ask the model for. `verbatim` is deliberately not one. */
export const MODEL_FIELDS = [
  'service',
  'scope',
  'location',
  'building',
  'room',
  'symptom',
  'observedAt',
] as const;

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

/**
 * Keeps extraction policy and schema in the system message while isolating the
 * reporter's untrusted text in the user message. Ambiguous fields stay unknown.
 */
export function buildPrompt(text: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You are extracting structured fields from a campus IT problem report. ' +
        'Do not diagnose, advise, or decide anything. The schema is ' +
        JSON.stringify(schemaFromCatalog(), null, 2) +
        '. Return only the JSON object. For service, scope, and symptom, use the exact ' +
        "catalog value or 'unknown'. emit 'unknown' as the field value for bounded " +
        "fields. For location, building, room, and observedAt, " +
        "use '' when the report does not establish the value; never use 'unknown' for " +
        'those four fields. Keep location as the canonical display name, building as ' +
        "the canonical building code, and room as a separate room token. Do not guess " +
        'the nearest building. A roomless building-level classroom AV report is valid. ' +
        'Scope is role-neutral: student, faculty, staff, and first-person wording alone ' +
        'do not establish individual scope. Explicit personal-device or only-me wording ' +
        'supports individual; named shared building or room impact supports location; ' +
        'explicit campus-wide breadth supports service_wide; ambiguity stays unknown. ' +
        'Use this compact taxonomy: page/load/error/blank web page or portal language -> ' +
        'web_portal + page_error; sign-in loops or repeated prompts -> auth_failure; ' +
        'will not connect, cannot connect, or no image/network -> no_connection unless ' +
        'the subject is a projector/display, which is classroom_av + equipment_unavailable; ' +
        'cutting out/on and off -> intermittent; slow/crawling -> slow. A network jack, ' +
        'ethernet, LAN, or wired network -> wired_network. Explicit wifi, Wi-Fi, wireless, ' +
        'or eduroam -> wifi. Generic internet or internet access without wifi/wireless or ' +
        'wired evidence -> unknown service, never guess wifi. VPN maps to vpn. Scope: ' +
        '"my laptop"/"only me"/"my login" plus a contrast such as someone else works -> ' +
        'individual; for VPN, a personal login/sign-in loop or repeated prompt is individual ' +
        'unless nobody/everyone is affected; a named building/room or "around/in" a place -> location; nobody, ' +
        'everyone, anywhere, or campus-wide breadth -> service_wide; generic portal ' +
        'failure and role words alone remain unknown. For observedAt, use ISO-8601 only ' +
        "if the report states a time; otherwise use ''. Never use 'now' or infer a time " +
        'from tense. Representative canonical examples: ' +
        JSON.stringify([
          { service: 'wifi', scope: 'location', location: 'North Residence Hall', building: 'NORTH RESIDENCE HALL', room: '', symptom: 'intermittent', observedAt: '' },
          { service: 'classroom_av', scope: 'location', location: 'Lecture Hall', building: 'CENTR', room: '214', symptom: 'equipment_unavailable', observedAt: '' },
          { service: 'web_portal', scope: 'unknown', location: '', building: '', room: '', symptom: 'page_error', observedAt: '' },
          { service: 'unknown', scope: 'location', location: 'Main Library', building: 'GEISEL', room: '', symptom: 'slow', observedAt: '' },
          { service: 'wired_network', scope: 'location', location: 'Student Center', building: 'PRICE', room: '', symptom: 'no_connection', observedAt: '' },
          { service: 'vpn', scope: 'individual', location: '', building: '', room: '', symptom: 'auth_failure', observedAt: '' },
        ]) + '.',
    },
    { role: 'user', content: text },
  ];
}

/**
 * Converts only known catalog aliases to canonical location fields. This is
 * deterministic and lossless for the location vocabulary; it avoids spending
 * the one model repair on casing, display-name, or room-token differences.
 */
function canonicalizeLocationFields(candidate: unknown): unknown {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return candidate;
  const record = candidate as Record<string, unknown>;
  return {
    ...record,
    location: canonicalLocation(record.location) || (record.location === '' ? '' : record.location),
    building: canonicalBuilding(record.building) || (record.building === '' ? '' : record.building),
    room: canonicalRoom(record.room) || (record.room === '' ? '' : record.room),
  };
}

/** Adds the malformed output and its specific error for the single repair call. */
export function repairPrompt(text: string, badOutput: string, error: string): ChatMessage[] {
  const base = buildPrompt(text);
  return [
    ...base,
    {
      role: 'user',
      content:
        `Your previous response was:\n\n${badOutput}\n\n` +
        `ERROR: ${error}\n\nPlease fix it and return only the JSON object.`,
    },
  ];
}

/**
 * Parses the first balanced JSON object from bare, fenced, or prose-wrapped
 * output. Braces inside strings are ignored, and malformed JSON returns null.
 */
export function extractFirstJsonObject(raw: string): unknown {
  const start = raw.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const character = raw[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      depth++;
    } else if (character === '}') {
      depth--;
    }

    if (depth === 0) {
      try {
        return JSON.parse(raw.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }

  return null;
}

/**
 * Strictly checks the model fields before normalization and returns the first
 * actionable validation error for repair. Validation never coerces model output.
 */
export function validateAgainstSchema(candidate: unknown): string | null {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return 'response is not a JSON object';
  }
  const record = candidate as Record<string, unknown>;
  const unexpected = Object.keys(record).find((field) => !(MODEL_FIELDS as readonly string[]).includes(field));
  if (unexpected !== undefined) {
    return `unexpected field ${unexpected}`;
  }
  for (const field of MODEL_FIELDS) {
    if (!(field in record)) {
      return `missing required field ${field}`;
    }
    if (typeof record[field] !== 'string') {
      return `field ${field} is not a string`;
    }
    if (record[field].trim() !== record[field]) {
      return `field ${field} has leading or trailing whitespace`;
    }
    if (record[field] === 'unknown' && (field === 'location' || field === 'building' || field === 'room')) {
      return `field ${field} must use '' rather than 'unknown'`;
    }
  }
  if (!(SERVICES as readonly string[]).includes(record.service as string)) {
    return `service: ${record.service} is not in the catalog`;
  }
  if (!(SCOPES as readonly string[]).includes(record.scope as string)) {
    return `scope: ${record.scope} is not in the catalog`;
  }
  if (!(SYMPTOMS as readonly string[]).includes(record.symptom as string)) {
    return `symptom: ${record.symptom} is not in the catalog`;
  }

  const location = record.location as string;
  const building = record.building as string;
  const room = record.room as string;
  const scope = record.scope as string;
  if (location !== '' && canonicalLocation(location) !== location) {
    return `location: ${location} is not canonical`;
  }
  if (building !== '' && canonicalBuilding(building) !== building) {
    return `building: ${building} is not a canonical building code`;
  }
  if (room !== '' && canonicalRoom(room) !== room) {
    return `room: ${room} is not canonical`;
  }
  if (location === '' && building !== '') {
    return 'building requires location';
  }
  if (room !== '' && building === '') {
    return 'room requires building';
  }
  if (location !== '' && building === '') {
    return 'location requires building';
  }
  if (location !== '' && canonicalBuilding(location) !== building) {
    return 'location and building do not form a canonical pair';
  }
  if ((scope === 'individual' || scope === 'service_wide') && (location !== '' || building !== '' || room !== '')) {
    return `${scope} scope cannot include location, building, or room`;
  }
  if (scope === 'location' && location === '') {
    return 'location scope requires location';
  }
  if (record.observedAt !== '' && Number.isNaN(Date.parse(record.observedAt as string))) {
    return 'observedAt is not a valid timestamp';
  }
  return null;
}

/**
 * Extracts and validates once, then makes exactly one repair attempt. The
 * telemetry flag is set before that call so failures still record the attempt.
 */
async function parseWithModel(
  text: string,
  deps: LlmParserDeps,
  telemetry: RepairTelemetry,
): Promise<unknown> {
  const raw = await deps.client.complete(buildPrompt(text));
  const candidate = canonicalizeLocationFields(extractFirstJsonObject(raw));
  const error = candidate === null
    ? 'response contained no JSON object'
    : validateAgainstSchema(candidate);

  if (error === null) return candidate;

  telemetry.repairAttempted = true;
  const raw2 = await deps.client.complete(repairPrompt(text, raw, error));
  const candidate2 = canonicalizeLocationFields(extractFirstJsonObject(raw2));
  const error2 = candidate2 === null
    ? 'response contained no JSON object'
    : validateAgainstSchema(candidate2);

  if (error2 === null) return candidate2;

  throw new Error('llm parser: repair failed');
}

/** Mutable handle preserves repair telemetry when the model call throws. */
type RepairTelemetry = { repairAttempted: boolean };

/**
 * Fails closed to the deterministic keyword parser while preserving source and
 * repair telemetry for auditing.
 */
function keywordFallback(text: string, repairAttempted: boolean): ParseResult {
  return { report: parseReport(text), source: 'keyword', repairAttempted };
}

/**
 * Returns normalized model output or a deterministic fallback; model failures
 * degrade parsing quality rather than endpoint availability.
 */
export function createLlmParser(deps: LlmParserDeps): { parse(text: string): Promise<ParseResult> } {
  return {
    async parse(text: string): Promise<ParseResult> {
      const telemetry: RepairTelemetry = { repairAttempted: false };
      try {
        const record = await parseWithModel(text, deps, telemetry);

        const modelRecord =
          typeof record === 'object' && record !== null ? (record as Record<string, unknown>) : {};

        return {
          // Verbatim always comes from the original report, never model output.
          report: normalize({ ...modelRecord, verbatim: text }, deps.now()),
          source: 'llm',
          repairAttempted: telemetry.repairAttempted,
        };
      } catch {
        // Provider errors may echo request text, so they do not cross into logs.
        return keywordFallback(text, telemetry.repairAttempted);
      }
    },
  };
}
