// components/response_composer.md + contracts/ticket_payload.md.
//
// The composer owns every word this service says, so these are the tests that
// decide whether "never fabricates an outage" is a property or a hope. The most
// important one is the MATCHED_CLUSTER wording check: it is the friendliest
// sentence in the system and the most dangerous.

import { beforeEach, describe, expect, it } from 'vitest';

import { configureGate, resetGate } from '../src/clusterGate';
import { compose, HUMAN_PATH } from '../src/composer';
import type { DeclaredIncident, PeerTicket, ProblemReport } from '../src/contracts/types';
import { handleReport } from '../src/orchestrator';
import { configureThrottle, resetThrottle } from '../src/throttleLimits';
import { SERVICES, SYMPTOMS, TICKET_CLASSES } from '../src/vocab/catalog';
import { CORPUS_NOW } from './corpus';
import { harness, IDENTITY_REF, TEST_GATE, TEST_THROTTLE } from './harness';

const DECLARED = {
  status: 'investigating',
  statusUpdatedAt: '2026-07-28T11:45:00.000Z',
  summary: 'Wi-Fi disruption affecting North Residence Hall',
  url: 'https://status.example.edu/incident/INC1001',
} as const;

beforeEach(() => {
  resetGate();
  resetThrottle();
  configureGate(TEST_GATE);
  configureThrottle(TEST_THROTTLE);
});

describe('MATCHED_DECLARED — the one reply allowed to speak about service state', () => {
  const reply = (): string => compose({ outcome: 'MATCHED_DECLARED', incident: DECLARED });

  it('quotes the record verbatim — status and summary string-match the source', () => {
    expect(reply()).toContain(DECLARED.summary);
    expect(reply()).toContain(DECLARED.status);
  });

  it('always carries statusUpdatedAt alongside status — a bare status reads as current', () => {
    expect(reply()).toContain(DECLARED.statusUpdatedAt);
  });

  it('links the record and states that nothing was created', () => {
    expect(reply()).toContain(DECLARED.url);
    expect(reply()).toMatch(/not created a new ticket/i);
  });
});

describe('MATCHED_CLUSTER — counts only, never a claim about the service', () => {
  const reply = (n = 5): string =>
    compose({ outcome: 'MATCHED_CLUSTER', reportCount: n, ticketIds: ['REQ300', 'REQ301'] });

  it('reports how many others and that tickets are open', () => {
    expect(reply()).toMatch(/5 other people have/);
    expect(reply()).toMatch(/tickets are already open/);
  });

  it('makes NO service-state claim — this is the line that matters most', () => {
    const text = reply().toLowerCase();
    // Five people reporting a problem is five people reporting a problem. Saying
    // otherwise makes this service a second source of truth about campus
    // infrastructure (boundaries.md boundary 2).
    for (const forbidden of [
      'known issue',
      'is down',
      'outage',
      'we are aware',
      "we're aware",
      'being worked on',
      'should be fixed',
      'currently affected',
      'service is degraded',
    ]) {
      expect(text, `cluster reply must not say "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it('never renders a status or a summary, because the variant carries neither', () => {
    expect(reply()).not.toContain(DECLARED.status);
    expect(reply()).not.toContain(DECLARED.summary);
  });

  it('handles the singular without reading as a template', () => {
    expect(compose({ outcome: 'MATCHED_CLUSTER', reportCount: 1, ticketIds: ['REQ300'] })).toMatch(
      /1 other person has .* a ticket is already open/,
    );
  });
});

describe('both deflect templates carry the override affordance', () => {
  it('a person told "already handled" is never left without recourse', () => {
    const declared = compose({ outcome: 'MATCHED_DECLARED', incident: DECLARED });
    const cluster = compose({ outcome: 'MATCHED_CLUSTER', reportCount: 5, ticketIds: ['REQ300'] });

    for (const reply of [declared, cluster]) {
      expect(reply).toMatch(/not the same problem/i);
      expect(reply).toMatch(/file your report separately/i);
    }
  });
});

describe('no template promises anything this service cannot deliver', () => {
  const every = [
    compose({ outcome: 'MATCHED_DECLARED', incident: DECLARED }),
    compose({ outcome: 'MATCHED_CLUSTER', reportCount: 5, ticketIds: ['REQ300'] }),
    compose({ outcome: 'FILED_INCIDENT', ticketNumber: 'INC0000001', url: 'u' }),
    compose({ outcome: 'FILED_REQUEST', ticketNumber: 'REQ0000001', url: 'u' }),
    compose({ outcome: 'NEEDS_DETAIL', missingFields: ['scope'] }),
    compose({ outcome: 'THROTTLED', retryAfterSeconds: 300 }),
    compose({ outcome: 'UNAVAILABLE', reason: 'incident_search_failed' }),
  ];

  it('renders no ETA — not restated, not inferred, not softened into "shortly"', () => {
    // A restoration time this service has no standing to promise is the single
    // most damaging sentence it could emit. Word-bounded: "details" is fine.
    const etaWords = /\b(shortly|soon|eta|asap|by tomorrow|within the hour|restored by|fixed by)\b/i;
    for (const reply of every) {
      expect(reply, `ETA language in: ${reply.slice(0, 60)}…`).not.toMatch(etaWords);
    }
  });

  it('renders only ticket numbers it was handed — never one the sink did not return', () => {
    // The filed templates echo exactly the number createTicket() returned…
    expect(compose({ outcome: 'FILED_INCIDENT', ticketNumber: 'INC0000042', url: 'u' })).toContain(
      'INC0000042',
    );
    expect(compose({ outcome: 'FILED_REQUEST', ticketNumber: 'REQ0000042', url: 'u' })).toContain(
      'REQ0000042',
    );
    // …and the deflect templates cite only ids they were given from EXISTING
    // records (the matched incident, the open peer tickets) — never a new one.
    const cluster = compose({ outcome: 'MATCHED_CLUSTER', reportCount: 5, ticketIds: ['REQ300'] });
    expect(cluster).toContain('REQ300');
    expect(cluster).toMatch(/not created another one/i);

    // Nothing is invented: no outcome that was handed no number renders one.
    for (const bare of [
      compose({ outcome: 'NEEDS_DETAIL', missingFields: ['scope'] }),
      compose({ outcome: 'THROTTLED', retryAfterSeconds: 60 }),
      compose({ outcome: 'UNAVAILABLE', reason: 'ticket_create_failed' }),
    ]) {
      expect(bare).not.toMatch(/INC\d|REQ\d/);
    }
  });

  it('gives every degraded outcome a human path', () => {
    expect(compose({ outcome: 'THROTTLED', retryAfterSeconds: 60 })).toContain(HUMAN_PATH);
    for (const reason of [
      'identity_unavailable',
      'incident_search_failed',
      'ticket_create_failed',
      'ticket_create_ambiguous',
    ] as const) {
      expect(compose({ outcome: 'UNAVAILABLE', reason })).toContain(HUMAN_PATH);
    }
  });

  it('NEEDS_DETAIL asks for one thing, in words a person can answer', () => {
    expect(compose({ outcome: 'NEEDS_DETAIL', missingFields: ['scope'] })).toMatch(
      /just you, one building, or the whole campus/,
    );
    expect(compose({ outcome: 'NEEDS_DETAIL', missingFields: ['service'] })).toMatch(/wifi, VPN/);
    expect(compose({ outcome: 'NEEDS_DETAIL', missingFields: ['location'] })).toMatch(/building or area/);
  });
});

describe('TicketPayload — completeness and legibility (ticket_payload.md)', () => {
  const filedPayload = async (report: ProblemReport, candidates: (PeerTicket | DeclaredIncident)[] = []) => {
    const h = harness(report);
    h.incidents.seed(candidates);
    await handleReport(
      { text: report.verbatim, identityRef: IDENTITY_REF, canFollowUp: true },
      h.deps,
    );
    return h.tickets.filed[0];
  };

  const INCIDENT: ProblemReport = {
    service: 'wifi',
    scope: 'location',
    location: 'North Residence Hall',
    building: 'NORTH RESIDENCE HALL',
    room: '',
    symptom: 'intermittent',
    observedAt: CORPUS_NOW,
    verbatim: 'the wifi in North Residence Hall keeps dropping',
  };
  const REQUEST: ProblemReport = {
    service: 'web_portal',
    scope: 'individual',
    location: '',
    building: '',
    room: '',
    symptom: 'auth_failure',
    observedAt: '',
    verbatim: 'the housing portal keeps signing me out',
  };

  it('every required field is non-empty on BOTH filing branches', async () => {
    for (const report of [INCIDENT, REQUEST]) {
      const p = await filedPayload(report);
      // Required = everything except location, observedAt, peerTicketIds,
      // overriddenMatchId, and a null snowUserId.
      expect(p.ticketClass).toBeTruthy();
      expect(p.category).toBeTruthy();
      expect(p.service).toBeTruthy();
      expect(p.scope).toBeTruthy();
      expect(p.symptom).toBeTruthy();
      expect(p.description).toBeTruthy();
      expect(p.requester.reporterName).toBeTruthy();
      expect(p.requester.affiliation).toBeTruthy();
      expect(p.reportedVia).toBe('campus-issue-reporter');
      expect(p.auditCorrelationId).toBeTruthy();
    }
  });

  it('every non-description field is a bounded catalog value', async () => {
    const p = await filedPayload(INCIDENT);
    expect(TICKET_CLASSES).toContain(p.ticketClass);
    expect(SERVICES).toContain(p.service as (typeof SERVICES)[number]);
    expect(SYMPTOMS).toContain(p.symptom as (typeof SYMPTOMS)[number]);
    expect(['individual', 'location', 'service_wide']).toContain(p.scope);
  });

  it('the description quotes the reporter EXACTLY once and adds no prose', async () => {
    const p = await filedPayload(INCIDENT);
    const occurrences = p.description.split(INCIDENT.verbatim).length - 1;
    expect(occurrences).toBe(1);
    // Composed by code from the parsed fields — never authored by a model.
    expect(p.description).toContain('Service: wifi');
    expect(p.description).toContain('Location: North Residence Hall');
  });

  it('records what we checked before filing, so a bad dedup is debuggable later', async () => {
    const peer: PeerTicket = {
      kind: 'peer_ticket',
      id: 'REQ300',
      service: 'wifi',
      scope: 'location',
       locations: ['North Residence Hall'],
       building: 'NORTH RESIDENCE HALL',
       room: '',
      symptom: 'intermittent',
      openedAt: CORPUS_NOW,
      matchScore: 0,
      reporterHash: 'rh_a',
      url: 'u',
    };
    const p = await filedPayload(INCIDENT, [peer]);
    // A ticket filed at clusterSize 1 should visibly show why it was correct.
    expect(p.peerTicketIds).toEqual(['REQ300']);
    expect(p.clusterSize).toBe(1);
    expect(p.topMatchScore).toBeGreaterThan(0);
  });

  it('never carries a raw identity into the ticket body', async () => {
    const p = await filedPayload(INCIDENT);
    expect(p.description).not.toContain(IDENTITY_REF);
    expect(p.requester.reporterName).not.toContain(IDENTITY_REF);
  });
});
