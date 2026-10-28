// components/mock_adapters.md — the seven stage-1 implementations.
//
// The most important test in this file is the last one. safety/boundaries.md's
// "read and create only" rule is enforced by the METHOD LIST, not by a comment,
// so a test that walks the prototypes and fails on a `close`/`update`/`resolve`
// is the only thing that keeps the enforcement mechanical.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  AmbiguousCreateError,
  InMemoryIdentityContext,
  InMemoryIncidentSource,
  InMemoryMatchFeedbackSink,
  InMemoryRateLimiter,
  InMemoryReportStream,
  InMemoryTicketSink,
  UnwiredStatusReader,
} from '../src/adapters/memory';
import { configureGate, resetGate } from '../src/clusterGate';
import type { DeclaredIncident, PeerTicket, TicketPayload } from '../src/contracts/types';
import { configureThrottle, resetThrottle } from '../src/throttleLimits';
import { CORPUS_NOW } from './corpus';
import { TEST_GATE, TEST_THROTTLE } from './harness';

const muirPeer: PeerTicket = {
  kind: 'peer_ticket',
  id: 'REQ300',
  service: 'wifi',
  scope: 'location',
  locations: ['North Residence Hall'],
  building: 'NORTH RESIDENCE HALL',
  room: '',
  symptom: 'intermittent',
  openedAt: CORPUS_NOW,
  matchScore: 0.11, // deliberately wrong — the adapter must recompute it
  reporterHash: 'rh_a',
  url: 'https://its.example.edu/ticket/REQ300',
};

const warrenDeclared: DeclaredIncident = {
  kind: 'declared_incident',
  id: 'INC1003',
  service: 'wifi',
  scope: 'location',
  locations: ['South Residence Hall'],
  building: 'SOUTH RESIDENCE HALL',
  room: '',
  symptom: 'intermittent',
  openedAt: CORPUS_NOW,
  matchScore: 0.99,
  reporterHash: '',
  url: 'https://status.example.edu/incident/INC1003',
  status: 'investigating',
  statusUpdatedAt: CORPUS_NOW,
  summary: 'Wi-Fi disruption affecting South Residence Hall',
};

const muirQuery = { service: 'wifi', location: 'North Residence Hall', building: 'NORTH RESIDENCE HALL', room: '', scope: 'location', symptom: 'intermittent' };

beforeEach(() => {
  resetGate();
  resetThrottle();
  configureGate(TEST_GATE);
  configureThrottle(TEST_THROTTLE);
});

describe('IncidentSource', () => {
  it('is deterministic — the same query against the same seed set scores identically', async () => {
    const s = new InMemoryIncidentSource();
    s.seed([muirPeer, warrenDeclared]);
    const a = await s.search(muirQuery);
    const b = await s.search(muirQuery);
    expect(a).toEqual(b);
    // Boundary tests around cluster_gate.md are meaningless otherwise.
  });

  it('computes matchScore itself rather than trusting the source record', async () => {
    const s = new InMemoryIncidentSource();
    s.seed([muirPeer]);
    const [found] = await s.search(muirQuery);
    expect(found.matchScore).not.toBe(muirPeer.matchScore);
    expect(found.matchScore).toBe(1);
  });

  it('disqualifies a location disagreement outright (report_corpus.md F6)', async () => {
    const s = new InMemoryIncidentSource();
    s.seed([warrenDeclared]);
    const [found] = await s.search(muirQuery);
    // A South Residence Hall incident does not cover North Residence Hall however well the rest lines up.
    expect(found.matchScore).toBe(0);
  });

  it('disqualifies a scope disagreement even when service and symptom match', async () => {
    const s = new InMemoryIncidentSource();
    s.seed([{ ...muirPeer, scope: 'individual', locations: [] }]);
    const [found] = await s.search(muirQuery);
    expect(found.matchScore).toBe(0);
  });

  it('preserves the same-scope symptom-mismatch score', async () => {
    const s = new InMemoryIncidentSource();
    s.seed([{ ...muirPeer, symptom: 'slow' }]);
    const [found] = await s.search(muirQuery);
    expect(found.matchScore).toBe(0.7);
  });

  it('filters by service before scoring anything', async () => {
    const s = new InMemoryIncidentSource();
    s.seed([{ ...muirPeer, service: 'vpn' }]);
    expect(await s.search(muirQuery)).toHaveLength(0);
  });

  it('returns both kinds in one call, sorted by score', async () => {
    const s = new InMemoryIncidentSource();
    s.seed([warrenDeclared, muirPeer]);
    const found = await s.search(muirQuery);
    expect(found.map((c) => c.kind)).toEqual(['peer_ticket', 'declared_incident']);
  });
});

describe('failure injection counts down', () => {
  it('failTimes = 1 fails once then recovers; Infinity stays down', async () => {
    const s = new InMemoryIncidentSource();
    s.failTimes = 1;
    await expect(s.search(muirQuery)).rejects.toThrow();
    await expect(s.search(muirQuery)).resolves.toEqual([]);

    s.failTimes = Number.POSITIVE_INFINITY;
    await expect(s.search(muirQuery)).rejects.toThrow();
    await expect(s.search(muirQuery)).rejects.toThrow();
  });
});

describe('TicketSink', () => {
  const payload = { ticketClass: 'INC' } as TicketPayload;

  it('returns a realistic number and records the payload', async () => {
    const t = new InMemoryTicketSink();
    const { ticketNumber, url } = await t.createTicket(payload);
    expect(ticketNumber).toMatch(/^INC\d+$/);
    expect(url).toContain(ticketNumber);
    expect(t.filed).toHaveLength(1);
  });

  it('THROWS on failure — it never returns a fabricated ticket number', async () => {
    const t = new InMemoryTicketSink();
    t.failTimes = 1;
    await expect(t.createTicket(payload)).rejects.toThrow();
    expect(t.filed).toHaveLength(0);
  });

  it('distinguishes an ambiguous timeout from a refusal', async () => {
    const t = new InMemoryTicketSink();
    t.failTimes = 1;
    t.ambiguous = true;
    await expect(t.createTicket(payload)).rejects.toBeInstanceOf(AmbiguousCreateError);
  });
});

describe('IdentityContext', () => {
  it('is deterministic per identityRef and never echoes the raw reference', async () => {
    const id = new InMemoryIdentityContext();
    const a = await id.resolve('session-abc');
    const b = await id.resolve('session-abc');
    const c = await id.resolve('session-xyz');

    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
    expect(a.hash).not.toContain('session');
  });

  it('returns snowUserId: null as a NORMAL case, not an error', async () => {
    const { snowUserId, affiliation } = await new InMemoryIdentityContext().resolve('x');
    expect(snowUserId).toBeNull();
    expect(affiliation).not.toBe('');
  });
});

describe('ReportStream', () => {
  it('publish returns void — the response path can never await it', () => {
    const s = new InMemoryReportStream();
    const result = s.publish({
      ts: CORPUS_NOW,
      correlationId: 'c',
      service: 'wifi',
      scope: 'location',
      location: 'North Residence Hall',
      symptom: 'intermittent',
      observedAt: '',
      building: 'NORTH RESIDENCE HALL', room: '',
      reporterHash: 'rh',
      outcome: 'FILE_INCIDENT',
      ticketNumber: 'INC1',
      viaOverride: false,
    });
    expect(result).toBeUndefined();
    expect(s.events).toHaveLength(1);
  });
});

describe('StatusReader — present, not wired', () => {
  it('returns null rather than guessing a status', async () => {
    expect(await new UnwiredStatusReader().readStatus()).toBeNull();
  });
});

describe('the method list IS the governance control (safety/boundaries.md)', () => {
  // Asserting the EXACT method surface, rather than grepping for banned verbs,
  // is what makes this mechanical: a new method cannot be added to any adapter
  // without this test failing and forcing the boundaries.md conversation. (A
  // banned-verb regex also mis-fires — IdentityContext.resolve() resolves an
  // identity reference; it does not resolve a ticket.)
  const SURFACE = [
    { adapter: new InMemoryIncidentSource(), contract: ['search'], setupOnly: ['seed', 'add'] },
    { adapter: new InMemoryTicketSink(), contract: ['createTicket'], setupOnly: [] },
    { adapter: new InMemoryReportStream(), contract: ['publish'], setupOnly: [] },
    { adapter: new InMemoryMatchFeedbackSink(), contract: ['recordOverride'], setupOnly: [] },
    { adapter: new InMemoryIdentityContext(), contract: ['resolve'], setupOnly: [] },
    {
      adapter: new InMemoryRateLimiter(() => new Date(CORPUS_NOW)),
      contract: ['check', 'record'],
      setupOnly: ['recent'], // `private` is erased at runtime; named so it is accounted for
    },
    { adapter: new UnwiredStatusReader(), contract: ['readStatus'], setupOnly: [] },
  ];

  for (const { adapter, contract, setupOnly } of SURFACE) {
    it(`${adapter.constructor.name} exposes its interface and nothing else`, () => {
      const actual = Object.getOwnPropertyNames(Object.getPrototypeOf(adapter))
        .filter((n) => n !== 'constructor')
        .sort();
      expect(actual).toEqual([...contract, ...setupOnly].sort());
    });
  }

  it('no adapter anywhere can close, update, escalate, reassign or acknowledge', () => {
    const forbidden = ['close', 'update', 'escalate', 'reassign', 'acknowledge', 'resolveTicket', 'delete', 'comment'];
    for (const { adapter } of SURFACE) {
      const names = Object.getOwnPropertyNames(Object.getPrototypeOf(adapter));
      for (const f of forbidden) {
        expect(names, `${adapter.constructor.name} exposes ${f}`).not.toContain(f);
      }
    }
  });

  it('the only write surface in the whole system is createTicket', () => {
    const sink = new InMemoryTicketSink();
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(sink)).filter(
      (n) => n !== 'constructor',
    );
    expect(methods).toEqual(['createTicket']);
  });
});
