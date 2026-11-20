// The field rules every parsed record must satisfy before normalization.
//
// One place, shared by the Claude parser (llmParser.ts) and the specialist
// router (router.ts): a candidate from either model is accepted only if these
// rules pass. They encode what a JSON schema cannot: canonical location and
// building pairs, and scope agreeing with whether a place was named.

import { SCOPES, SERVICES, SYMPTOMS } from '../vocab/catalog';
import { canonicalBuilding, canonicalLocation, canonicalRoom } from '../vocab/locations';

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
 * Strictly checks the model fields before normalization and returns the first
 * actionable validation error for repair. Validation never coerces model output.
 * It still runs under `strict: true`: the schema guarantee is the API's promise,
 * and this is our own trust boundary.
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
  if (record.observedAt !== '' && !isIsoTimestamp(record.observedAt)) {
    return "observedAt must be an ISO-8601 date-time such as 2026-11-20T14:00:00 (zone optional), or ''";
  }
  return null;
}

/**
 * A strict ISO-8601 date-time; the zone is optional because a reporter rarely
 * gives one. Date.parse alone is not enough: it also accepts free text such as
 * "Jan 1 2020 (call this number)", and observedAt is written into the ticket
 * description outside the quoted reporter text. This pattern admits only digits
 * and the characters - : . T Z +, so no words can get through.
 */
export function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}
