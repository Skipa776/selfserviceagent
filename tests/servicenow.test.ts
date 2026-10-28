// ServiceNow PDI adapter tests against recorded envelopes, with no network or
// credentials. The method-list, number integrity,
// and fail-loudly checks enforce safety properties in addition to field mapping.

import { describe, expect, it } from 'vitest';

import { CompositeIncidentSource } from '../src/adapters/composite';
import type { IncidentSource } from '../src/contracts/adapters';
import {
  REPORTED_VIA,
  SNOW_COLUMNS,
  ServiceNowIncidentSource,
  ServiceNowTicketSink,
  decodeLocation,
  encodeLocation,
  snowConfigFromEnv,
  snowTimeToIso,
  toPeerTicket,
  type Fetch,
  type SnowConfig,
} from '../src/adapters/servicenow';
import { AmbiguousCreateError } from '../src/adapters/memory';
import type { PeerTicket, TicketPayload } from '../src/contracts/types';
import { CORPUS_NOW } from './corpus';

const CONFIG: SnowConfig = {
  instanceUrl: 'https://dev00000.service-now.com',
  user: 'admin',
  password: 'not-a-real-password',
  incidentTable: 'incident',
  requestTable: 'sc_request',
  timeoutMs: 1_000,
  readScope: 'service_owned',
};

const VERBATIM = 'the wifi in North Residence Hall keeps dropping and I cannot get anything done';

const PAYLOAD: TicketPayload = {
  ticketClass: 'INC',
  category: 'wifi',
  service: 'wifi',
  scope: 'location',
  location: 'North Residence Hall',
  building: 'NORTH RESIDENCE HALL',
  room: '',
  symptom: 'intermittent',
  observedAt: '',
  description: `Reported by reporter abc123def456.\n\nIn their words:\n"${VERBATIM}"\n`,
  requester: { snowUserId: null, reporterName: 'reporter abc123def456', affiliation: 'campus-member' },
  reportedVia: 'campus-issue-reporter',
  peerTicketIds: ['INC0010001', 'INC0010002'],
  clusterSize: 4,
  topMatchScore: 0.8,
  filedViaOverride: false,
  overriddenMatchId: '',
  auditCorrelationId: 'corr-abc-123',
};

// ── A fake fetch that replays recorded PDI envelopes ──────────────────────────

type Recorded = { status: number; body: unknown } | { throws: unknown };

type Recorder = Fetch & { requests: { url: string; method: string; body: unknown }[] };

function fakeFetch(...responses: readonly Recorded[]): Recorder {
  const requests: { url: string; method: string; body: unknown }[] = [];

  const impl = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const i = requests.length;
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });

    const recorded = responses[i];
    if (recorded === undefined) throw new Error(`fake fetch: unexpected request #${i + 1}`);
    if ('throws' in recorded) throw recorded.throws;

    return {
      ok: recorded.status >= 200 && recorded.status < 300,
      status: recorded.status,
      json: async () => recorded.body,
    } as Response;
  }) as Recorder;

  impl.requests = requests;
  return impl;
}

/** What AbortSignal.timeout() actually rejects with. */
const timeoutError = (): unknown => new DOMException('The operation timed out.', 'TimeoutError');

/** One row as the Table API returns it: flat strings, UTC dates, no timezone. */
function snowRow(over: Record<string, string> = {}): Record<string, string> {
  return {
    number: 'INC0010007',
    sys_id: '9f8e7d6c5b4a39281706f5e4d3c2b1a0',
    opened_at: '2026-07-28 11:30:00',
    [SNOW_COLUMNS.service]: 'wifi',
    [SNOW_COLUMNS.scope]: 'location',
    [SNOW_COLUMNS.symptom]: 'intermittent',
    [SNOW_COLUMNS.location]: 'North Residence Hall',
    [SNOW_COLUMNS.reporterHash]: 'rh_abc123',
    ...over,
  };
}

const QUERY = { service: 'wifi', location: 'North Residence Hall', building: 'NORTH RESIDENCE HALL', room: '', scope: 'location', symptom: 'intermittent' };

// ── Config ────────────────────────────────────────────────────────────────────

describe('configuration', () => {
  it('is null when unconfigured, never a throw', () => {
    // Same contract as the LLM client: an absent credential is a documented
    // degraded mode, not a boot failure. Stage 1 must still run on a clean clone.
    expect(snowConfigFromEnv({})).toBeNull();
    expect(snowConfigFromEnv({ SNOW_INSTANCE_URL: 'https://x' })).toBeNull();
    expect(snowConfigFromEnv({ SNOW_INSTANCE_URL: 'https://x', SNOW_USER: 'a' })).toBeNull();
  });

  it('reads the three required values and strips a trailing slash', () => {
    const config = snowConfigFromEnv({
      SNOW_INSTANCE_URL: 'https://dev00000.service-now.com/',
      SNOW_USER: 'admin',
      SNOW_PASSWORD: 'pw',
    });
    expect(config?.instanceUrl).toBe('https://dev00000.service-now.com');
    expect(config?.incidentTable).toBe('incident');
    expect(config?.requestTable).toBe('sc_request');
    expect(config?.readScope).toBe('service_owned');
  });

  it('reduces a pasted auto-login link to a bare origin', () => {
    // The developer portal hands out exactly this link, so it is the single most
    // likely thing to land in SNOW_INSTANCE_URL — it is what you get when you
    // click through to your own instance. Carried into the config, the password
    // travels into every request URL and every message built from one.
    // This happened, on this project, and the credential reached a transcript.
    const config = snowConfigFromEnv({
      SNOW_INSTANCE_URL:
        'https://dev00000.service-now.com/login.do?user_name=admin&sys_action=sysverb_login&user_password=%2Bhunter2',
      SNOW_USER: 'admin',
      SNOW_PASSWORD: 'pw',
    });

    expect(config?.instanceUrl).toBe('https://dev00000.service-now.com');
    expect(config?.instanceUrl).not.toContain('hunter2');
    expect(config?.instanceUrl).not.toContain('?');
  });

  it('drops any path, query or fragment, not just the parameter we thought of', () => {
    for (const raw of [
      'https://dev00000.service-now.com/nav_to.do?uri=incident_list.do',
      'https://dev00000.service-now.com/api/now/table/incident',
      'https://dev00000.service-now.com/#/anything',
    ]) {
      expect(snowConfigFromEnv({ SNOW_INSTANCE_URL: raw, SNOW_USER: 'a', SNOW_PASSWORD: 'p' })?.instanceUrl).toBe(
        'https://dev00000.service-now.com',
      );
    }
  });

  it('accepts a bare hostname and assumes https', () => {
    expect(
      snowConfigFromEnv({ SNOW_INSTANCE_URL: 'dev00000.service-now.com', SNOW_USER: 'a', SNOW_PASSWORD: 'p' })
        ?.instanceUrl,
    ).toBe('https://dev00000.service-now.com');
  });

  it('is null on a URL it cannot parse, rather than building a broken request', () => {
    expect(snowConfigFromEnv({ SNOW_INSTANCE_URL: 'http://', SNOW_USER: 'a', SNOW_PASSWORD: 'p' })).toBeNull();
  });

  it('lets the request table be overridden to incident', () => {
    // The documented fallback if a PDI rejects a direct sc_request create: both
    // classes into one table, u_scope still distinguishes them. Config, not code.
    const config = snowConfigFromEnv({
      SNOW_INSTANCE_URL: 'https://x',
      SNOW_USER: 'a',
      SNOW_PASSWORD: 'p',
      SNOW_REQUEST_TABLE: 'incident',
    });
    expect(config?.requestTable).toBe('incident');
  });

  it('enables all_tagged reads only when explicitly configured', () => {
    const base = { SNOW_INSTANCE_URL: 'https://x', SNOW_USER: 'a', SNOW_PASSWORD: 'p' };
    expect(snowConfigFromEnv({ ...base, SNOW_READ_SCOPE: 'all_tagged' })?.readScope).toBe('all_tagged');
    expect(snowConfigFromEnv({ ...base, SNOW_READ_SCOPE: 'anything_else' })?.readScope).toBe('service_owned');
  });
});

// ── The governance control ────────────────────────────────────────────────────

describe('the method list IS the governance control (safety/boundaries.md)', () => {
  // The most important test in this file, and it is green from the first commit.
  // These adapters authenticate as a PDI admin — an account that CAN close,
  // resolve and reassign anything on the instance. The reason this service
  // cannot is that no such method exists to call.
  const SURFACE = [
    { adapter: new ServiceNowTicketSink(CONFIG, fakeFetch()), contract: ['createTicket'] },
    { adapter: new ServiceNowIncidentSource(CONFIG, fakeFetch()), contract: ['search'] },
  ];

  for (const { adapter, contract } of SURFACE) {
    it(`${adapter.constructor.name} exposes its interface and nothing else`, () => {
      const actual = Object.getOwnPropertyNames(Object.getPrototypeOf(adapter))
        .filter((n) => n !== 'constructor')
        .sort();
      expect(actual).toEqual([...contract].sort());
    });
  }

  it('neither can close, update, escalate, reassign, acknowledge or resolve', () => {
    const forbidden = ['close', 'update', 'escalate', 'reassign', 'acknowledge', 'resolve', 'delete', 'comment'];
    for (const { adapter } of SURFACE) {
      const names = Object.getOwnPropertyNames(Object.getPrototypeOf(adapter));
      for (const f of forbidden) {
        expect(names, `${adapter.constructor.name} exposes ${f}`).not.toContain(f);
      }
    }
  });
});

// ── createTicket ──────────────────────────────────────────────────────────────

describe('createTicket routes and returns', () => {
  const created = { status: 201, body: { result: { number: 'INC0010042', sys_id: 'abc123' } } };

  it('posts an INC to the incident table', async () => {
    const fetchImpl = fakeFetch(created);
    await new ServiceNowTicketSink(CONFIG, fetchImpl).createTicket(PAYLOAD);

    expect(fetchImpl.requests[0].method).toBe('POST');
    expect(fetchImpl.requests[0].url).toContain('/api/now/table/incident');
  });

  it('posts a REQ to the request table', async () => {
    const fetchImpl = fakeFetch(created);
    await new ServiceNowTicketSink(CONFIG, fetchImpl).createTicket({ ...PAYLOAD, ticketClass: 'REQ' });

    expect(fetchImpl.requests[0].url).toContain('/api/now/table/sc_request');
  });

  it("returns the instance's own number and a deep link to the record", async () => {
    const result = await new ServiceNowTicketSink(CONFIG, fakeFetch(created)).createTicket(PAYLOAD);

    expect(result).toEqual({
      ticketNumber: 'INC0010042',
      url: `${CONFIG.instanceUrl}/nav_to.do?uri=incident.do%3Fsys_id%3Dabc123`,
    });
  });
});

describe('createTicket NEVER fabricates a number (error_rescue_map.md)', () => {
  it.each([
    ['number', { sys_id: 'abc' }],
    ['sys_id', { number: 'INC0010042' }],
  ])('treats a 2xx missing %s as ambiguous', async (_field, result) => {
    const fetchImpl = fakeFetch({ status: 201, body: { result } });
    await expect(new ServiceNowTicketSink(CONFIG, fetchImpl).createTicket(PAYLOAD)).rejects.toBeInstanceOf(
      AmbiguousCreateError,
    );
  });

  it('treats a 2xx with no result as ambiguous', async () => {
    const fetchImpl = fakeFetch({ status: 200, body: {} });
    await expect(new ServiceNowTicketSink(CONFIG, fetchImpl).createTicket(PAYLOAD)).rejects.toBeInstanceOf(
      AmbiguousCreateError,
    );
  });

  it('throws on a 4xx', async () => {
    const fetchImpl = fakeFetch({ status: 400, body: {} });
    await expect(new ServiceNowTicketSink(CONFIG, fetchImpl).createTicket(PAYLOAD)).rejects.toThrow();
  });

  it('never puts the password in a thrown message', async () => {
    // The message reaches the audit log. A ServiceNow 401 body can echo request
    // headers (safety/boundaries.md — no credential leaves the request).
    const fetchImpl = fakeFetch({ status: 401, body: { error: { detail: 'admin:not-a-real-password' } } });
    await expect(new ServiceNowTicketSink(CONFIG, fetchImpl).createTicket(PAYLOAD)).rejects.toThrow(
      /^(?!.*not-a-real-password).*$/,
    );
  });
});

describe('ambiguous vs plain failure (error_rescue_map.md, two adjacent rows)', () => {
  it.each([
    ['timeout', { throws: timeoutError() }],
    ['network error', { throws: new TypeError('fetch failed') }],
    ['server error', { status: 503, body: {} }],
  ] satisfies [string, Recorded][])('%s is ambiguous', async (_kind, failure) => {
    const fetchImpl = fakeFetch(failure);
    await expect(
      new ServiceNowTicketSink(CONFIG, fetchImpl).createTicket(PAYLOAD),
    ).rejects.toBeInstanceOf(AmbiguousCreateError);
  });

  it.each([400, 429, 499])('a %s is a plain failure because the instance answered and refused', async (status) => {
    // An explicit client response makes the orchestrator's single retry safe.
    const fetchImpl = fakeFetch({ status, body: {} });
    await expect(
      new ServiceNowTicketSink(CONFIG, fetchImpl).createTicket(PAYLOAD),
    ).rejects.not.toBeInstanceOf(AmbiguousCreateError);
  });
});

describe('the field mapping', () => {
  it('sends exactly the mapped columns and nothing else', async () => {
    // An exact key set, not a subset. Two failures in one assertion: a missing
    // mapped column, and an extra column nobody agreed to — `caller_id` above
    // all. requester.snowUserId is null at every stage-2 request (no SSO), so a
    // guessed caller_id would attribute someone's report to the wrong human.
    const fetchImpl = fakeFetch({ status: 201, body: { result: { number: 'INC1', sys_id: 's1' } } });
    await new ServiceNowTicketSink(CONFIG, fetchImpl).createTicket(PAYLOAD);

    const body = fetchImpl.requests[0].body as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual(
      [
        'description',
        'short_description',
        SNOW_COLUMNS.auditCorrelationId,
         SNOW_COLUMNS.location,
        SNOW_COLUMNS.reportedVia,
        SNOW_COLUMNS.reporterHash,
        SNOW_COLUMNS.scope,
        SNOW_COLUMNS.service,
        SNOW_COLUMNS.symptom,
      ].sort(),
    );
  });

  it('carries the catalog values and the constants', async () => {
    const fetchImpl = fakeFetch({ status: 201, body: { result: { number: 'INC1', sys_id: 's1' } } });
    await new ServiceNowTicketSink(CONFIG, fetchImpl).createTicket(PAYLOAD);

    const body = fetchImpl.requests[0].body as Record<string, string>;
    expect(body[SNOW_COLUMNS.service]).toBe('wifi');
    expect(body[SNOW_COLUMNS.scope]).toBe('location');
    expect(body[SNOW_COLUMNS.symptom]).toBe('intermittent');
    expect(body[SNOW_COLUMNS.location]).toBe('North Residence Hall');
    expect(body[SNOW_COLUMNS.auditCorrelationId]).toBe('corr-abc-123');
    // The peer-search filter depends on this exact string being on every record
    // we file. Get it wrong and the cluster count silently reads zero forever.
    expect(body[SNOW_COLUMNS.reportedVia]).toBe(REPORTED_VIA);
  });

  it('encodes rooms in u_location and decodes legacy location-only values', () => {
    expect(encodeLocation('CENTR', '214', 'Lecture Hall')).toBe('Lecture Hall|room=214');
    expect(decodeLocation('Lecture Hall|room=214')).toEqual({ location: 'Lecture Hall', building: 'CENTR', room: '214' });
    expect(decodeLocation('North Residence Hall')).toEqual({ location: 'North Residence Hall', building: 'NORTH RESIDENCE HALL', room: '' });
  });

  it('carries the reporter hash, so peers can be counted as distinct', async () => {
    // cluster_gate.md counts DISTINCT reporters. A record filed without this is a
    // record that can never participate in a cluster count.
    const fetchImpl = fakeFetch({ status: 201, body: { result: { number: 'INC1', sys_id: 's1' } } });
    await new ServiceNowTicketSink(CONFIG, fetchImpl).createTicket(PAYLOAD);

    const body = fetchImpl.requests[0].body as Record<string, string>;
    expect(body[SNOW_COLUMNS.reporterHash]).toBe('abc123def456');
  });

  it('short_description is catalog values only — never the reporter\'s words', async () => {
    // The US-9 legibility surface: the only thing an agent sees in a list view.
    // verbatim belongs in description, quoted once (ticket_payload.md).
    const fetchImpl = fakeFetch({ status: 201, body: { result: { number: 'INC1', sys_id: 's1' } } });
    await new ServiceNowTicketSink(CONFIG, fetchImpl).createTicket(PAYLOAD);

    const body = fetchImpl.requests[0].body as Record<string, string>;
    expect(body.short_description).not.toBe('');
    expect(body.short_description).not.toContain(VERBATIM);
    expect(body.short_description).not.toContain('cannot get anything done');
  });

  it('the description shows why filing was correct at clusterSize 4', async () => {
    // ticket_payload.md: "a ticket filed at clusterSize: 4 should visibly show why
    // it was correct to file", answerable from the ticket alone. There are no
    // columns for the dedup evidence, so it goes in the description.
    const fetchImpl = fakeFetch({ status: 201, body: { result: { number: 'INC1', sys_id: 's1' } } });
    await new ServiceNowTicketSink(CONFIG, fetchImpl).createTicket(PAYLOAD);

    const body = fetchImpl.requests[0].body as Record<string, string>;
    expect(body.description).toContain(VERBATIM);
    expect(body.description).toContain('4');
    expect(body.description).toContain('INC0010001');
  });

  it('omits overridden match evidence from a normal ticket', async () => {
    const fetchImpl = fakeFetch({ status: 201, body: { result: { number: 'INC1', sys_id: 's1' } } });
    await new ServiceNowTicketSink(CONFIG, fetchImpl).createTicket(PAYLOAD);

    const body = fetchImpl.requests[0].body as Record<string, string>;
    expect(body.description).not.toContain('overridden match:');
  });

  it('includes nonempty overridden match evidence for an override', async () => {
    const fetchImpl = fakeFetch({ status: 201, body: { result: { number: 'INC1', sys_id: 's1' } } });
    await new ServiceNowTicketSink(CONFIG, fetchImpl).createTicket({
      ...PAYLOAD,
      filedViaOverride: true,
      overriddenMatchId: 'INC0099999',
    });

    const body = fetchImpl.requests[0].body as Record<string, string>;
    expect(body.description).toContain('overridden match: INC0099999');
  });

  it('rejects a reporter name that does not contain the expected hash', async () => {
    const sink = new ServiceNowTicketSink(CONFIG, fakeFetch());
    await expect(
      sink.createTicket({ ...PAYLOAD, requester: { ...PAYLOAD.requester, reporterName: 'anonymous' } }),
    ).rejects.toThrow('invalid reporter name');
  });
});

// ── Reading peer tickets back ─────────────────────────────────────────────────

describe('snowTimeToIso', () => {
  it("reads ServiceNow's naked datetime as UTC, not local", () => {
    // The bug this exists to prevent is invisible: parsed as local, every peer
    // ticket shifts by the host's offset and the cluster_gate.md match window
    // moves with it. CI in UTC would never catch what a laptop in PDT hits.
    expect(snowTimeToIso('2026-07-28 11:30:00')).toBe('2026-07-28T11:30:00.000Z');
  });

  it('accepts a real ISO string unchanged', () => {
    expect(snowTimeToIso('2026-07-28T11:30:00.000Z')).toBe('2026-07-28T11:30:00.000Z');
  });

  it("returns '' rather than guessing", () => {
    for (const bad of ['', '   ', 'yesterday', null, undefined, 42]) {
      expect(snowTimeToIso(bad)).toBe('');
    }
  });
});

describe('toPeerTicket — discard, never synthesize (match_candidate.md)', () => {
  it('rebuilds a peer ticket from a well-formed record', () => {
    const got = toPeerTicket(snowRow(), CONFIG.instanceUrl, 'incident');

    expect(got).not.toBeNull();
    expect(got?.kind).toBe('peer_ticket');
    expect(got?.id).toBe('INC0010007');
    expect(got?.service).toBe('wifi');
    expect(got?.scope).toBe('location');
    expect(got?.locations).toEqual(['North Residence Hall']);
    expect(got?.symptom).toBe('intermittent');
    expect(got?.reporterHash).toBe('rh_abc123');
    expect(got?.openedAt).toBe('2026-07-28T11:30:00.000Z');
    expect(got?.url).toBe(
      `${CONFIG.instanceUrl}/nav_to.do?uri=incident.do%3Fsys_id%3D9f8e7d6c5b4a39281706f5e4d3c2b1a0`,
    );
  });

  it('reads encoded AV rooms and preserves legacy records', () => {
    expect(toPeerTicket(snowRow({ [SNOW_COLUMNS.location]: 'Lecture Hall|room=214' }), CONFIG.instanceUrl, 'incident')).toMatchObject({
      locations: ['Lecture Hall'], building: 'CENTR', room: '214',
    });
    expect(toPeerTicket(snowRow(), CONFIG.instanceUrl, 'incident')).toMatchObject({ locations: ['North Residence Hall'], building: 'NORTH RESIDENCE HALL', room: '' });
  });

  it('a service-wide record has no locations, not an empty-string one', () => {
    const got = toPeerTicket(
      snowRow({ [SNOW_COLUMNS.scope]: 'service_wide', [SNOW_COLUMNS.location]: '' }),
      CONFIG.instanceUrl,
      'incident',
    );
    // scoring.ts treats a candidate with no locations as location-agnostic; a
    // [''] would compare against nothing and disqualify every match.
    expect(got?.locations).toEqual([]);
  });

  it('discards a record with no reporter hash', () => {
    // Defaulting to '' would collapse every broken record into "one reporter",
    // and cluster_gate.md counts distinct reporters. A synthesized identity
    // corrupts the count in whichever direction the default points.
    expect(toPeerTicket(snowRow({ [SNOW_COLUMNS.reporterHash]: '' }), CONFIG.instanceUrl, 'incident')).toBeNull();
  });

  it('discards a record with an unparseable opened_at', () => {
    expect(toPeerTicket(snowRow({ opened_at: 'sometime' }), CONFIG.instanceUrl, 'incident')).toBeNull();
  });

  it('discards a record missing any required catalog field', () => {
    for (const column of [SNOW_COLUMNS.service, SNOW_COLUMNS.scope, SNOW_COLUMNS.symptom]) {
      expect(toPeerTicket(snowRow({ [column]: '' }), CONFIG.instanceUrl, 'incident'), column).toBeNull();
    }
  });

  it.each([
    ['service', SNOW_COLUMNS.service, 'not_a_service'],
    ['scope', SNOW_COLUMNS.scope, 'not_a_scope'],
    ['unknown scope', SNOW_COLUMNS.scope, 'unknown'],
    ['symptom', SNOW_COLUMNS.symptom, 'not_a_symptom'],
  ])('discards a record with invalid %s', (_label, column, value) => {
    expect(toPeerTicket(snowRow({ [column]: value }), CONFIG.instanceUrl, 'incident')).toBeNull();
  });

  it('never produces a candidate carrying an authoritative status', () => {
    // A ticket THIS SERVICE FILED is evidence somebody reported something, and
    // nothing about whether the service is up. boundaries.md boundary 2 — five
    // reports is not an outage. The type already forbids it; this catches a cast.
    const got = toPeerTicket(
      snowRow({ state: '2', short_description: 'Wi-Fi down campus-wide' }),
      CONFIG.instanceUrl,
      'incident',
    );
    const loose = got as unknown as Record<string, unknown> | null;
    expect(loose?.status).toBeUndefined();
    expect(loose?.summary).toBeUndefined();
    expect(loose?.statusUpdatedAt).toBeUndefined();
  });
});

describe('ServiceNowIncidentSource.search', () => {
  const twoTables = (rows: Record<string, string>[]): Recorded[] => [
    { status: 200, body: { result: rows } },
    { status: 200, body: { result: [] } },
  ];

  it('defaults to our own open, tagged tickets for this service', async () => {
    const fetchImpl = fakeFetch(...twoTables([]));
    await new ServiceNowIncidentSource(CONFIG, fetchImpl).search(QUERY);

    const url = decodeURIComponent(fetchImpl.requests[0].url);
    // Without the reportedVia filter, an unrelated incident somebody opened by
    // hand in the PDI joins the cluster count.
    expect(url).toContain(`${SNOW_COLUMNS.reportedVia}=${REPORTED_VIA}`);
    expect(url).toContain('active=true');
    expect(url).toContain(`${SNOW_COLUMNS.service}=wifi`);
    expect(url).toContain(`${SNOW_COLUMNS.scope}ISNOTEMPTY`);
    expect(url).toContain(`${SNOW_COLUMNS.symptom}ISNOTEMPTY`);
    expect(url).toContain(`${SNOW_COLUMNS.reporterHash}ISNOTEMPTY`);
    expect(url).toContain(`${SNOW_COLUMNS.location}ISNOTEMPTY`);
    expect(url).not.toContain('u_building');
    expect(url).not.toContain('u_room');
  });

  it('all_tagged omits only the ownership filter', async () => {
    const fetchImpl = fakeFetch({ status: 200, body: { result: [] } });
    await new ServiceNowIncidentSource({ ...CONFIG, readScope: 'all_tagged' }, fetchImpl).search(QUERY);

    const url = decodeURIComponent(fetchImpl.requests[0].url);
    expect(url).not.toContain(`${SNOW_COLUMNS.reportedVia}=${REPORTED_VIA}`);
    expect(url).toContain('active=true');
    expect(url).toContain(`${SNOW_COLUMNS.service}=wifi`);
    expect(url).toContain(`${SNOW_COLUMNS.scope}ISNOTEMPTY`);
    expect(url).toContain(`${SNOW_COLUMNS.symptom}ISNOTEMPTY`);
    expect(url).toContain(`${SNOW_COLUMNS.reporterHash}ISNOTEMPTY`);
    expect(url).toContain(`${SNOW_COLUMNS.location}ISNOTEMPTY`);
    expect(fetchImpl.requests).toHaveLength(1);
    expect(url).toContain('/table/incident');
  });

  it('reads both tables, because a peer may be an INC or a REQ', async () => {
    const fetchImpl = fakeFetch(...twoTables([]));
    await new ServiceNowIncidentSource(CONFIG, fetchImpl).search(QUERY);

    expect(fetchImpl.requests).toHaveLength(2);
    expect(fetchImpl.requests.map((r) => r.url).join(' ')).toContain('/table/incident');
    expect(fetchImpl.requests.map((r) => r.url).join(' ')).toContain('/table/sc_request');
  });

  it('reads one table when both classes are routed to it', async () => {
    const fetchImpl = fakeFetch({ status: 200, body: { result: [] } });
    await new ServiceNowIncidentSource({ ...CONFIG, requestTable: 'incident' }, fetchImpl).search(QUERY);

    expect(fetchImpl.requests).toHaveLength(1);
  });

  it('recomputes matchScore from the query and sorts descending', async () => {
    const fetchImpl = fakeFetch(
      ...twoTables([
        snowRow({ number: 'INC1', [SNOW_COLUMNS.symptom]: 'slow' }),
        snowRow({ number: 'INC2' }),
      ]),
    );
    const got = await new ServiceNowIncidentSource(CONFIG, fetchImpl).search(QUERY);

    expect(got.map((c) => c.id)).toEqual(['INC2', 'INC1']);
    expect(got[0].matchScore).toBeGreaterThan(got[1].matchScore);
  });

  it('all_tagged disqualifies cross-scope rows even when service and symptom match', async () => {
    const fetchImpl = fakeFetch({
      status: 200,
      body: {
        result: [
          snowRow({
            number: 'REQ1',
            [SNOW_COLUMNS.scope]: 'individual',
            [SNOW_COLUMNS.location]: '',
          }),
        ],
      },
    });
    const [got] = await new ServiceNowIncidentSource({ ...CONFIG, readScope: 'all_tagged' }, fetchImpl).search(QUERY);

    expect(got.matchScore).toBe(0);
  });

  it('all_tagged drops missing hashes and catalog-invalid rows', async () => {
    const fetchImpl = fakeFetch(
      {
        status: 200,
        body: {
          result: [
            snowRow({ number: 'INC1', [SNOW_COLUMNS.reporterHash]: '' }),
            snowRow({ number: 'INC2', [SNOW_COLUMNS.symptom]: 'not_a_symptom' }),
            snowRow({ number: 'INC3' }),
          ],
        },
      },
    );
    const got = await new ServiceNowIncidentSource({ ...CONFIG, readScope: 'all_tagged' }, fetchImpl).search(QUERY);

    expect(got.map((c) => c.id)).toEqual(['INC3']);
  });

  it('propagates a failure rather than returning an empty result', async () => {
    // The search is most likely to be down during exactly the
    // incident that would have deflected the report. An empty array here is
    // indistinguishable from "nothing matched" and the orchestrator would file —
    // producing the flood the feature exists to prevent.
    const fetchImpl = fakeFetch({ status: 500, body: {} }, { status: 200, body: { result: [] } });
    await expect(new ServiceNowIncidentSource(CONFIG, fetchImpl).search(QUERY)).rejects.toThrow();
  });
});

// ── Composite ─────────────────────────────────────────────────────────────────

describe('CompositeIncidentSource', () => {
  const candidate = (id: string, matchScore: number): PeerTicket => ({
    kind: 'peer_ticket',
    id,
    service: 'wifi',
    scope: 'location',
    locations: ['North Residence Hall'],
    building: 'NORTH RESIDENCE HALL', room: '',
    symptom: 'intermittent',
    openedAt: CORPUS_NOW,
    matchScore,
    reporterHash: `rh_${id}`,
    url: 'u',
  });

  const stub = (...cs: PeerTicket[]): IncidentSource => ({ search: async () => cs });
  const broken: IncidentSource = {
    search: async () => {
      throw new Error('source unreachable');
    },
  };

  it('merges every source and re-sorts by score', async () => {
    const got = await new CompositeIncidentSource([
      stub(candidate('A', 0.4)),
      stub(candidate('B', 0.9), candidate('C', 0.6)),
    ]).search(QUERY);

    expect(got.map((c) => c.id)).toEqual(['B', 'C', 'A']);
  });

  it('fails the whole search when ANY source fails', async () => {
    // The load-bearing one. A partial result looks exactly like a complete one,
    // and the orchestrator would file instead of returning UNAVAILABLE — the
    // flood arriving through a helpful-looking catch block.
    await expect(new CompositeIncidentSource([stub(candidate('A', 0.4)), broken]).search(QUERY)).rejects.toThrow();
  });

  it('exposes search and nothing else', () => {
    const names = Object.getOwnPropertyNames(
      Object.getPrototypeOf(new CompositeIncidentSource([])),
    ).filter((n) => n !== 'constructor');
    expect(names).toEqual(['search']);
  });
});
