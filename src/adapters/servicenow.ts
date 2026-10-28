// Stage-2 ServiceNow PDI adapters. Their public surface is intentionally limited
// to ticket creation and peer-ticket search; mutation methods are absent by
// contract (safety/boundaries.md boundary 1).
//
// 1. Both target tables extend `task`, so the five custom u_* columns live on `task`
//    and both inherit them. `correlation_id` and `correlation_display` are native
//    task columns.
// 2. Dates come back as 'YYYY-MM-DD HH:MM:SS' in UTC with no timezone marker.
//    They must be normalized before matching to avoid shifting the match window.

import type { IncidentSource, TicketSink } from '../contracts/adapters';
import type { MatchCandidate, PeerTicket, TicketPayload, TicketScope } from '../contracts/types';
import { SCOPES, SERVICES, SYMPTOMS } from '../vocab/catalog';
import { AmbiguousCreateError } from './memory';
import { scoreCandidate, type SearchQuery } from './scoring';
import { canonicalBuilding, canonicalLocation, canonicalRoom } from '../vocab/locations';

// ── The field mapping, in one place ───────────────────────────────────────────

/** Shared write/read mapping for the PDI task columns. */
export const SNOW_COLUMNS = {
  service: 'u_service',
  scope: 'u_scope',
  symptom: 'u_symptom',
  location: 'u_location',
  reporterHash: 'u_reporter_hash',
  reportedVia: 'correlation_display',
  auditCorrelationId: 'correlation_id',
} as const;

/** Identifies tickets created by this service for measurement and peer search. */
export const REPORTED_VIA = 'campus-issue-reporter';

const LOCATION_SEPARATOR = '|room=';

export function encodeLocation(building: string, room: string, display: string): string {
  return room === '' ? display : `${display}${LOCATION_SEPARATOR}${room}`;
}

/** Decode new building/room values and preserve legacy location-only records. */
export function decodeLocation(value: unknown): { location: string; building: string; room: string } | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (raw === '') return { location: '', building: '', room: '' };
  const parts = raw.split(LOCATION_SEPARATOR);
  if (parts.length > 2 || parts[0] === '') return null;
  const display = parts[0];
  const location = canonicalLocation(display) || display;
  const building = canonicalBuilding(display);
  const room = parts.length === 2 ? canonicalRoom(parts[1]) : '';
  return { location, building, room };
}

export const SNOW_READ_SCOPES = ['service_owned', 'all_tagged'] as const;
export type SnowReadScope = (typeof SNOW_READ_SCOPES)[number];

// ── Config ────────────────────────────────────────────────────────────────────

export type SnowConfig = {
  readonly instanceUrl: string;
  readonly user: string;
  readonly password: string;
  readonly incidentTable: string;
  readonly requestTable: string;
  readonly timeoutMs: number;
  readonly readScope: SnowReadScope;
};

/** Table names remain configurable because some PDIs reject direct `sc_request` creates. */
const DEFAULTS = { incidentTable: 'incident', requestTable: 'sc_request', timeoutMs: 15_000 };

function readScopeFromEnv(value: string | undefined): SnowReadScope {
  return value?.trim() === 'all_tagged' ? 'all_tagged' : 'service_owned';
}

/** Drops paths, queries, and fragments so pasted auto-login URLs cannot leak credentials. */
export function toInstanceOrigin(raw: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return '';
  }
}

/** Null when unconfigured — never a throw. Same contract as the LLM client. */
export function snowConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SnowConfig | null {
  const rawUrl = env.SNOW_INSTANCE_URL?.trim();
  const user = env.SNOW_USER?.trim();
  const password = env.SNOW_PASSWORD;
  if (!rawUrl || !user || !password) return null;

  const instanceUrl = toInstanceOrigin(rawUrl);
  if (instanceUrl === '') return null;

  const timeout = Number(env.SNOW_TIMEOUT_MS);
  return {
    instanceUrl,
    user,
    password,
    incidentTable: env.SNOW_INCIDENT_TABLE?.trim() || DEFAULTS.incidentTable,
    requestTable: env.SNOW_REQUEST_TABLE?.trim() || DEFAULTS.requestTable,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULTS.timeoutMs,
    readScope: readScopeFromEnv(env.SNOW_READ_SCOPE),
  };
}

// ── Transport ─────────────────────────────────────────────────────────────────

/** Injected so tests drive recorded responses; defaults to Node's built-in. */
export type Fetch = typeof globalThis.fetch;

type SnowRecord = Record<string, unknown>;

class ServiceNowHttpError extends Error {
  constructor(readonly status: number) {
    super(`servicenow http ${status}`);
    this.name = 'ServiceNowHttpError';
  }
}

function authHeader(config: SnowConfig): string {
  return `Basic ${Buffer.from(`${config.user}:${config.password}`).toString('base64')}`;
}

/**
 * One Table API round trip. Throws on anything that is not a 2xx with a JSON
 * `result` — the CALLER decides what a failure means, which is what lets
 * error_rescue_map.md's rows differ (`ticket_create_failed` retries once;
 * `incident_search_failed` retries once then stops; neither ever invents data).
 *
 * The thrown message carries the status and nothing else. A ServiceNow 401 body
 * can echo request headers, and this message reaches the audit log
 * (safety/boundaries.md — no credential leaves the request).
 */
async function snowRequest(
  config: SnowConfig,
  fetchImpl: Fetch,
  path: string,
  init?: { method: 'POST'; body: unknown },
): Promise<unknown> {
  const res = await fetchImpl(`${config.instanceUrl}/api/now/table/${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: authHeader(config),
    },
    body: init === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  if (!res.ok) throw new ServiceNowHttpError(res.status);

  const body = (await res.json()) as { result?: unknown };
  if (body?.result === undefined) throw new Error('servicenow returned no result');
  return body.result;
}

/** Only an explicit 4xx proves ServiceNow rejected the create before applying it. */
function isAmbiguousFailure(error: unknown): boolean {
  return !(error instanceof ServiceNowHttpError && error.status >= 400 && error.status < 500);
}

// ── TicketSink — CREATE ONLY ──────────────────────────────────────────────────

export class ServiceNowTicketSink implements TicketSink {
  constructor(
    private readonly config: SnowConfig,
    private readonly fetchImpl: Fetch = globalThis.fetch,
  ) {}

  async createTicket(payload: TicketPayload): Promise<{ ticketNumber: string; url: string }> {
    const table = payload.ticketClass === 'INC' ? this.config.incidentTable : this.config.requestTable;
    const body = toSnowRecord(payload);

    let result: unknown;
    try {
      result = await snowRequest(this.config, this.fetchImpl, `${table}?sysparm_fields=number,sys_id`, {
        method: 'POST',
        body,
      });
    } catch (error) {
      throw isAmbiguousFailure(error) ? new AmbiguousCreateError() : toPlainFailure(error);
    }

    const record = result as SnowRecord;
    const ticketNumber = typeof record?.number === 'string' ? record.number.trim() : '';
    const sysId = typeof record?.sys_id === 'string' ? record.sys_id.trim() : '';

    // The create may have succeeded, so an incomplete receipt must never be retried.
    if (ticketNumber === '' || sysId === '') throw new AmbiguousCreateError();

    return {
      ticketNumber,
      url: recordUrl(this.config.instanceUrl, table, sysId),
    };
  }
}

function toPlainFailure(error: unknown): Error {
  return error instanceof Error ? error : new Error('servicenow create failed');
}

/** Maps the canonical payload to bounded task fields and fixed audit evidence. */
export function toSnowRecord(payload: TicketPayload): Record<string, string> {
  const reporterHash = extractReporterHash(payload.requester.reporterName);
  const short =
    `${payload.service} | ${payload.symptom} | ${payload.scope}` + (payload.location ? ` | ${payload.location}` : '');

  const isFiledViaOverride = payload.filedViaOverride ? 'yes' : 'no';
  const overriddenMatch =
    payload.filedViaOverride && payload.overriddenMatchId.trim() !== ''
      ? `overridden match: ${payload.overriddenMatchId}\n`
      : '';
  const dedupFooter =
    '\n\n--- DEDUP ---\n' +
    `peer tickets: ${payload.peerTicketIds.join(', ')}\n` +
    `cluster size: ${payload.clusterSize}\n` +
    `top match score: ${payload.topMatchScore}\n` +
    `filed via override: ${isFiledViaOverride}\n` +
    overriddenMatch;

  return {
    [SNOW_COLUMNS.service]: payload.service,
    [SNOW_COLUMNS.scope]: payload.scope,
    [SNOW_COLUMNS.symptom]: payload.symptom,
    [SNOW_COLUMNS.location]: encodeLocation(payload.building ?? '', payload.room ?? '', payload.location),
    [SNOW_COLUMNS.reporterHash]: reporterHash,
    [SNOW_COLUMNS.reportedVia]: REPORTED_VIA,
    [SNOW_COLUMNS.auditCorrelationId]: payload.auditCorrelationId,
    short_description: short,
    description: payload.description + dedupFooter,
  };
}

function extractReporterHash(reporterName: string): string {
  const match = /^reporter ([^\s]+)$/.exec(reporterName);
  if (match?.[1] === undefined) throw new Error('invalid reporter name');
  return match[1];
}

function recordUrl(instanceUrl: string, table: string, sysId: string): string {
  return `${instanceUrl}/nav_to.do?uri=${encodeURIComponent(`${table}.do?sys_id=${sysId}`)}`;
}

// ── IncidentSource — READ ONLY, peer tickets only ─────────────────────────────

/**
 * ServiceNow returns 'YYYY-MM-DD HH:MM:SS' in UTC with no timezone marker.
 * `new Date('2026-07-31 18:04:22')` parses that as LOCAL time, shifting every
 * peer ticket by the host's offset and quietly moving the cluster_gate.md match
 * window — an answer that is wrong with nothing visibly broken. Returns '' on
 * anything unparseable rather than guessing; the caller discards the record.
 */
export function snowTimeToIso(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return '';
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value.trim())
    ? `${value.trim().replace(' ', 'T')}Z`
    : value.trim();
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? '' : new Date(ms).toISOString();
}

/** Rebuilds a peer only when every required source field is valid and canonical. */
export function toPeerTicket(record: SnowRecord, instanceUrl: string, table: string): PeerTicket | null {
  const number = nonEmptyString(record.number);
  const sysId = nonEmptyString(record.sys_id);
  const service = nonEmptyString(record[SNOW_COLUMNS.service]);
  const scope = nonEmptyString(record[SNOW_COLUMNS.scope]);
  const symptom = nonEmptyString(record[SNOW_COLUMNS.symptom]);
  const reporterHash = nonEmptyString(record[SNOW_COLUMNS.reporterHash]);
  const decodedLocation = decodeLocation(record[SNOW_COLUMNS.location]);
  const openedAt = snowTimeToIso(record.opened_at);

  if (
    number === null ||
    sysId === null ||
    service === null ||
    !(SERVICES as readonly string[]).includes(service) ||
    scope === null ||
    !isTicketScope(scope) ||
    symptom === null ||
    !(SYMPTOMS as readonly string[]).includes(symptom) ||
    reporterHash === null ||
    decodedLocation === null ||
    openedAt === ''
  ) {
    return null;
  }

  return {
    kind: 'peer_ticket',
    id: number,
    service,
    scope,
    locations: decodedLocation.location === '' ? [] : [decodedLocation.location],
    building: decodedLocation.building,
    room: decodedLocation.room,
    symptom,
    openedAt,
    matchScore: 0,
    reporterHash,
    url: recordUrl(instanceUrl, table, sysId),
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function isTicketScope(value: string): value is TicketScope {
  return value !== 'unknown' && (SCOPES as readonly string[]).includes(value);
}

/**
 * Peer tickets read back out of the PDI. The default reads tickets this service
 * filed; the explicit all_tagged demo scope also admits manually tagged records.
 *
 * Declared incidents are NOT read here. adapters.md stage 2: "declared incidents
 * stay fixtures unless a read-only real feed exists", and no such feed is
 * confirmed. The composition root merges this with a
 * fixture declared source (composite.ts), so the declared-incident short-circuit
 * — half the decision rule — stays demonstrable at stage 2.
 */
export class ServiceNowIncidentSource implements IncidentSource {
  constructor(
    private readonly config: SnowConfig,
    private readonly fetchImpl: Fetch = globalThis.fetch,
    /** Cap on records per table. A demo instance is small; a real one is not. */
    private readonly limit = 100,
  ) {}

  async search(q: SearchQuery): Promise<MatchCandidate[]> {
    // Every mode reads open records for the parsed service. all_tagged is an
    // explicit demo scope for records carrying the integration metadata; the
    // default ownership marker keeps manually opened incidents out.
    const query = [
      ...(this.config.readScope === 'service_owned' ? [`${SNOW_COLUMNS.reportedVia}=${REPORTED_VIA}`] : []),
      'active=true',
      `${SNOW_COLUMNS.service}=${q.service}`,
      `${SNOW_COLUMNS.scope}ISNOTEMPTY`,
      `${SNOW_COLUMNS.symptom}ISNOTEMPTY`,
      `${SNOW_COLUMNS.reporterHash}ISNOTEMPTY`,
      ...(q.location === '' ? [] : [`${SNOW_COLUMNS.location}ISNOTEMPTY`]),
    ].join('^');

    const fields = [
      'number',
      'sys_id',
      'opened_at',
      SNOW_COLUMNS.service,
      SNOW_COLUMNS.scope,
      SNOW_COLUMNS.symptom,
      SNOW_COLUMNS.location,
      SNOW_COLUMNS.reporterHash,
    ].join(',');

    const tables =
      this.config.readScope === 'all_tagged'
        ? [this.config.incidentTable]
        : [this.config.incidentTable, this.config.requestTable];
    const unique = [...new Set(tables)];

    // ServiceNow has no cross-table join, so distinct tables are read concurrently.
    const perTable = await Promise.all(
      unique.map(async (table) => {
        const result = await snowRequest(
          this.config,
          this.fetchImpl,
          `${table}?sysparm_query=${encodeURIComponent(query)}` +
            `&sysparm_fields=${fields}&sysparm_limit=${this.limit}&sysparm_display_value=false`,
        );
        const rows = Array.isArray(result) ? (result as SnowRecord[]) : [];
        // Discard, never synthesize — toPeerTicket returns null for a record it
        // cannot trust, and those simply do not appear (error_rescue_map.md
        // `incident_source_malformed`: "proceed with the rest").
        return rows
          .map((row) => toPeerTicket(row, this.config.instanceUrl, table))
          .filter((c): c is PeerTicket => c !== null);
      }),
    );

    return perTable
      .flat()
      .map((c) => ({ ...c, matchScore: scoreCandidate(q, c) }))
      .sort((a, b) => b.matchScore - a.matchScore);
  }
}
