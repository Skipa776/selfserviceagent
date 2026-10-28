// safety/error_rescue_map.md, row for row — every failure marked `all` at stage 1.
//
// The map is the spec, not a description of what got built, so this file mirrors
// its table: induce the failure, assert the REQUIRED behaviour, assert the audit
// line. The rows marked stage 2/3 (llm_*, snow_user_not_found, status_read_failed)
// have nothing to fail yet and are deliberately absent.
//
// The invariant every row shares: no failure path fabricates a ticket number, an
// incident id, a service status, or a "we're aware of this" reassurance — and
// none of them ends in a dead end for the person reporting.

import { beforeEach, describe, expect, it } from 'vitest';

import { AmbiguousCreateError } from '../src/adapters/memory';
import { configureGate, resetGate } from '../src/clusterGate';
import { compose } from '../src/composer';
import type { ApiOutcome, PeerTicket, ProblemReport } from '../src/contracts/types';
import { handleReport } from '../src/orchestrator';
import { configureThrottle, resetThrottle } from '../src/throttleLimits';
import { CORPUS_NOW } from './corpus';
import { harness, IDENTITY_REF, TEST_GATE, TEST_THROTTLE } from './harness';

const MUIR_WIFI: ProblemReport = {
  service: 'wifi',
  scope: 'location',
  location: 'North Residence Hall',
  building: 'NORTH RESIDENCE HALL',
  room: '',
  symptom: 'intermittent',
  observedAt: '',
  verbatim: 'the wifi in North Residence Hall keeps dropping',
};

const request = (over?: Partial<Parameters<typeof handleReport>[0]>) => ({
  text: MUIR_WIFI.verbatim,
  identityRef: IDENTITY_REF,
  canFollowUp: true,
  ...over,
});

beforeEach(() => {
  resetGate();
  resetThrottle();
  configureGate(TEST_GATE);
  configureThrottle(TEST_THROTTLE);
});

describe('empty_report', () => {
  it('never throws, and logs the row rather than dropping it silently', async () => {
    const empty: ProblemReport = {
      service: 'unknown',
      scope: 'unknown',
      location: '',
      building: '',
      room: '',
      symptom: 'unknown',
      observedAt: '',
      verbatim: '',
    };
    const h = harness(empty);
    const res = await handleReport(request({ text: '   ' }), h.deps);

    expect(res.outcome).toBe('NEEDS_DETAIL');
    expect(h.audit.lines.some((l) => l.errorKind === 'empty_report')).toBe(true);
  });

  it('files a REQ from what exists when the caller cannot follow up', async () => {
    const empty: ProblemReport = {
      service: 'unknown',
      scope: 'unknown',
      location: '',
      building: '',
      room: '',
      symptom: 'unknown',
      observedAt: '',
      verbatim: '',
    };
    const h = harness(empty);
    const res = await handleReport(request({ text: '', canFollowUp: false }), h.deps);

    expect(res.outcome).toBe('FILED_REQUEST');
    expect(h.tickets.filed).toHaveLength(1);
  });
});

describe('incoherent_report', () => {
  it("scope 'location' with no location is normalized to unknown, then the gate decides", async () => {
    // What the parser hands over after applyCoherence: the scope was downgraded
    // but the location it could not justify is still absent. The orchestrator
    // recognizes that fingerprint and logs the row without widening the seam.
    const incoherent: ProblemReport = { ...MUIR_WIFI, scope: 'unknown', location: 'North Residence Hall' };
    const h = harness(incoherent);
    const res = await handleReport(request(), h.deps);

    expect(res.outcome).toBe('NEEDS_DETAIL');
    expect(h.audit.lines.some((l) => l.errorKind === 'incoherent_report')).toBe(true);
    expect(h.tickets.filed).toHaveLength(0);
  });
});

describe('identity_unavailable', () => {
  it('returns UNAVAILABLE with a human path — never an unthrottled pass', async () => {
    const h = harness(MUIR_WIFI);
    h.identity.failTimes = Number.POSITIVE_INFINITY;
    const res = await handleReport(request(), h.deps);

    expect(res.outcome).toBe('UNAVAILABLE');
    expect(res.reply).toContain('Service Desk');
    expect(h.tickets.filed).toHaveLength(0);
    // No identity means no throttle key — so nothing may have been searched either.
    expect(h.audit.lines.some((l) => l.action === 'searched')).toBe(false);
    expect(h.audit.lines.some((l) => l.errorKind === 'identity_unavailable')).toBe(true);
  });
});

describe('incident_search_failed', () => {
  it('retries exactly once, and a transient failure is rescued by the retry', async () => {
    const h = harness(MUIR_WIFI);
    h.incidents.failTimes = 1; // first call throws, retry succeeds
    const res = await handleReport(request(), h.deps);

    expect(res.outcome).toBe('FILED_INCIDENT');
    expect(h.tickets.filed).toHaveLength(1);
  });

  it('a persistent failure returns UNAVAILABLE and files nothing', async () => {
    const h = harness(MUIR_WIFI);
    h.incidents.failTimes = Number.POSITIVE_INFINITY;
    const res = await handleReport(request(), h.deps);

    expect(res.outcome).toBe('UNAVAILABLE');
    expect(h.tickets.filed).toHaveLength(0);
    expect(h.audit.lines.some((l) => l.errorKind === 'incident_search_failed')).toBe(true);
  });
});

describe('incident_source_malformed', () => {
  it('discards the bad record, proceeds with the rest, and never synthesizes a field', async () => {
    // A peer ticket carrying an authoritative status — the dangerous shape. It is
    // discarded rather than trusted; the well-formed peer beside it still counts.
    const poisoned = {
      kind: 'peer_ticket',
      id: 'REQ999',
      service: 'wifi',
      scope: 'location',
      locations: ['North Residence Hall'],
      symptom: 'intermittent',
      openedAt: CORPUS_NOW,
      matchScore: 0.9,
      reporterHash: 'rh_z',
      url: 'https://its.example.edu/ticket/REQ999',
      status: 'service is down', // illegal on a peer (match_candidate.md)
    } as unknown as PeerTicket;

    const h = harness(MUIR_WIFI);
    h.incidents.seed([poisoned]);
    const res = await handleReport(request(), h.deps);

    expect(res.outcome).toBe('FILED_INCIDENT');
    expect(h.audit.lines.some((l) => l.errorKind === 'incident_source_malformed')).toBe(true);
    // The discarded record contributed nothing — not a peer id, not a cluster count.
    expect(h.tickets.filed[0].peerTicketIds).toHaveLength(0);
    expect(h.tickets.filed[0].clusterSize).toBe(0);
    expect(res.reply).not.toContain('down');
  });
});

describe('ticket_create_failed', () => {
  it('retries once and succeeds on the retry', async () => {
    const h = harness(MUIR_WIFI);
    h.tickets.failTimes = 1;
    const res = await handleReport(request(), h.deps);

    expect(res.outcome).toBe('FILED_INCIDENT');
    expect(res.ticket?.ticketNumber).toBeTruthy();
  });

  it('on a second failure returns UNAVAILABLE and NEVER a fabricated ticket number', async () => {
    const h = harness(MUIR_WIFI);
    h.tickets.failTimes = Number.POSITIVE_INFINITY;
    const res = await handleReport(request(), h.deps);

    expect(res.outcome).toBe('UNAVAILABLE');
    expect(res.ticket).toBeUndefined();
    expect(res.reply).not.toMatch(/INC\d|REQ\d/);
    expect(res.reply).toContain('Service Desk');
    expect(h.audit.lines.some((l) => l.errorKind === 'ticket_create_failed')).toBe(true);
  });
});

describe('ticket_create_ambiguous', () => {
  it('does NOT retry blind, and says the report may already be filed', async () => {
    const h = harness(MUIR_WIFI);
    h.tickets.failTimes = 1;
    h.tickets.ambiguous = true;
    const res = await handleReport(request(), h.deps);

    expect(res.outcome).toBe('UNAVAILABLE');
    expect(res.reply).toContain('may already have been filed');
    // A duplicate is cheap; a silent double-file the key cannot catch is a lie.
    expect(h.tickets.filed).toHaveLength(0);
    expect(h.audit.lines.some((l) => l.errorKind === 'ticket_create_ambiguous')).toBe(true);
  });

  it('is a distinct error type, so it cannot be mistaken for a plain failure', () => {
    expect(new AmbiguousCreateError()).toBeInstanceOf(Error);
    expect(new AmbiguousCreateError().name).toBe('AmbiguousCreateError');
  });
});

describe('stream_publish_failed', () => {
  it("is swallowed — the user's result is unchanged and correct, audit line only", async () => {
    const h = harness(MUIR_WIFI);
    h.stream.fail = true;
    const res = await handleReport(request(), h.deps);

    expect(res.outcome).toBe('FILED_INCIDENT');
    expect(res.ticket?.ticketNumber).toBeTruthy();
    expect(h.audit.lines.some((l) => l.errorKind === 'stream_publish_failed')).toBe(true);
  });
});

describe('feedback_sink_failed', () => {
  it('the ticket is still filed and the overridden line still carries the label', async () => {
  const peer: PeerTicket = {
      kind: 'peer_ticket',
      id: 'REQ300',
      service: 'wifi',
      scope: 'location',
    locations: ['North Residence Hall'],
    building: 'NORTH RESIDENCE HALL', room: '',
      symptom: 'intermittent',
      openedAt: CORPUS_NOW,
      matchScore: 0.95,
      reporterHash: 'rh_a',
      url: 'https://its.example.edu/ticket/REQ300',
    };

    const h = harness(MUIR_WIFI);
    h.incidents.seed([peer]);
    h.feedback.failTimes = Number.POSITIVE_INFINITY;
    const res = await handleReport(request({ overrideMatchId: 'REQ300' }), h.deps);

    expect(res.outcome).toBe('FILED_INCIDENT');
    expect(h.feedback.overrides).toHaveLength(0); // the store rejected it…
    // …and the label survives in the log anyway (match_feedback.md).
    expect(h.audit.lines.some((l) => l.action === 'overridden' && l.overriddenMatchId === 'REQ300')).toBe(true);
    expect(h.audit.lines.some((l) => l.errorKind === 'feedback_sink_failed')).toBe(true);
  });
});

describe('no_template — a build-time failure, not a runtime empty string', () => {
  it('every one of the seven outcomes renders non-empty text', () => {
    const inputs: Parameters<typeof compose>[0][] = [
      {
        outcome: 'MATCHED_DECLARED',
        incident: { status: 's', statusUpdatedAt: 't', summary: 'm', url: 'u' },
      },
      { outcome: 'MATCHED_CLUSTER', reportCount: 5, ticketIds: ['REQ1'] },
      { outcome: 'FILED_INCIDENT', ticketNumber: 'INC1', url: 'u' },
      { outcome: 'FILED_REQUEST', ticketNumber: 'REQ1', url: 'u' },
      { outcome: 'NEEDS_DETAIL', missingFields: ['scope'] },
      { outcome: 'THROTTLED', retryAfterSeconds: 120 },
      { outcome: 'UNAVAILABLE', reason: 'incident_search_failed' },
    ];

    const covered = new Set<ApiOutcome>();
    for (const i of inputs) {
      expect(compose(i).length).toBeGreaterThan(20);
      covered.add(i.outcome);
    }
    expect(covered.size).toBe(7);
  });
});

describe('the shared invariant across every row', () => {
  const inducers: ReadonlyArray<[string, (h: ReturnType<typeof harness>) => void]> = [
    ['incident_search_failed', (h) => (h.incidents.failTimes = Number.POSITIVE_INFINITY)],
    ['ticket_create_failed', (h) => (h.tickets.failTimes = Number.POSITIVE_INFINITY)],
    ['identity_unavailable', (h) => (h.identity.failTimes = Number.POSITIVE_INFINITY)],
  ];

  for (const [kind, induce] of inducers) {
    it(`${kind}: no stack trace, no internal identifier, always a human path`, async () => {
      const h = harness(MUIR_WIFI);
      induce(h);
      const res = await handleReport(request(), h.deps);

      expect(res.outcome).toBe('UNAVAILABLE');
      expect(res.reply).not.toMatch(/Error|\.ts:|undefined|null/);
      expect(res.reply).toContain('Service Desk');
      expect(h.tickets.filed).toHaveLength(0);
    });
  }
});
