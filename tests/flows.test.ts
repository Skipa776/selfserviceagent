// Flow scenarios F1–F17 (contracts/report_corpus.md) — the stage-1 exit criterion.
// F14/F15 add the per-topic existing-ticket ceiling: 9 existing Canvas tickets
// allow the 10th filing; 10 existing tickets suppress the 11th report. F16/F17
// prove the classroom AV boundary: 2 existing files the third; 3 suppress the next.
//
// These measure THE CODE, not the parser: inputs are records, not prose
// (report_corpus.md, "Responsibility"). The parser is therefore stubbed to hand
// back the fixture record verbatim, so a flow failure can only mean the
// deterministic core is wrong — never that a keyword missed.

import { beforeEach, describe, expect, it } from 'vitest';

import { configureGate, resetGate } from '../src/clusterGate';
import { handleReport } from '../src/orchestrator';
import { configureThrottle, resetThrottle } from '../src/throttleLimits';
import { ticketClassFor } from '../src/vocab/catalog';
import type { DeclaredIncident } from '../src/contracts/types';
import type { TicketScope } from '../src/vocab/catalog';
import { CORPUS_NOW, FLOWS, type FlowScenario } from './corpus';
import { harness, IDENTITY_REF, TEST_GATE, TEST_THROTTLE, type Harness } from './harness';

async function runScenario(s: FlowScenario): Promise<Harness & { response: Awaited<ReturnType<typeof handleReport>> }> {
  const h = harness(s.report);
  h.incidents.seed(s.world.candidates);
  if (s.world.searchFails === true) h.incidents.failTimes = Number.POSITIVE_INFINITY;
  if (s.world.throttled === true) {
    // Spend the budget honestly through the real limiter rather than setting the
    // limit to zero — the counting rule is what F12 is actually about.
    const { hash } = await h.deps.identity.resolve(IDENTITY_REF);
    for (let i = 0; i < TEST_THROTTLE.maxReportsPerIdentity; i++) {
      await h.limiter.record(hash, s.report);
    }
  }

  const response = await handleReport(
    {
      text: s.report.verbatim,
      identityRef: IDENTITY_REF,
      canFollowUp: s.world.canFollowUp,
      overrideMatchId: s.world.overrideMatchId,
    },
    h.deps,
  );
  return { ...h, response };
}

describe('flow scenarios (report_corpus.md F1–F17)', () => {
  beforeEach(() => {
    resetGate();
    resetThrottle();
    configureGate(TEST_GATE);
    configureThrottle(TEST_THROTTLE);
  });

  for (const s of FLOWS) {
    it(`${s.id} — ${s.note}`, async () => {
      const { response, tickets } = await runScenario(s);
      expect(response.outcome).toBe(s.expected);
      expect(tickets.filed.length).toBe(s.filesTicket ? 1 : 0);
    });
  }
});

describe('the count boundary is the product (F3 vs F2)', () => {
  beforeEach(() => {
    resetGate();
    resetThrottle();
    configureGate(TEST_GATE);
    configureThrottle(TEST_THROTTLE);
  });

  it('files at threshold-1 existing reporters and deflects at the threshold', async () => {
    // Default threshold is 5. F3 sees 4 existing reporters and files the 5th
    // ticket; F2 sees 5 existing reporters and suppresses the 6th report.
    const below = await runScenario(FLOWS.find((f) => f.id === 'F3')!);
    const at = await runScenario(FLOWS.find((f) => f.id === 'F2')!);

    expect(below.response.outcome).toBe('FILED_INCIDENT');
    expect(at.response.outcome).toBe('MATCHED_CLUSTER');
    expect(below.tickets.filed[0].clusterSize).toBe(4);
  });

  it('five tickets from one reporter is one reporter, not a cluster (F4)', async () => {
    const { response, tickets } = await runScenario(FLOWS.find((f) => f.id === 'F4')!);
    expect(response.outcome).toBe('FILED_INCIDENT');
    expect(tickets.filed[0].clusterSize).toBe(1);
    expect(tickets.filed[0].peerTicketIds).toHaveLength(5);
  });

  it('files the third classroom AV ticket, then suppresses the next report (F16/F17)', async () => {
    const below = await runScenario(FLOWS.find((f) => f.id === 'F16')!);
    const at = await runScenario(FLOWS.find((f) => f.id === 'F17')!);
    expect(below.response.outcome).toBe('FILED_INCIDENT');
    expect(below.tickets.filed[0].clusterSize).toBe(2);
    expect(at.response.outcome).toBe('MATCHED_CLUSTER');
    expect(at.response.cluster?.reportCount).toBe(3);
    expect(at.response.ticket).toBeUndefined();
  });
});

describe('deflect outcomes create nothing and always offer recourse', () => {
  beforeEach(() => {
    resetGate();
    resetThrottle();
    configureGate(TEST_GATE);
    configureThrottle(TEST_THROTTLE);
  });

  it('MATCHED_DECLARED carries the quoted record, no ticket, and an override handle', async () => {
    const { response, tickets } = await runScenario(FLOWS.find((f) => f.id === 'F1')!);
    expect(tickets.filed).toHaveLength(0);
    expect(response.incident?.id).toBe('INC1001');
    expect(response.incident?.status).toBe('investigating');
    expect(response.override?.matchId).toBe('INC1001');
    expect(response.ticket).toBeUndefined();
    expect(response.cluster).toBeUndefined();
  });

  it('selects the highest-score qualifying declared incident instead of a higher-score stale one', async () => {
    const scenario = FLOWS.find((f) => f.id === 'F1')!;
    const h = harness(scenario.report);
    const base = scenario.world.candidates.find(
      (candidate): candidate is DeclaredIncident => candidate.kind === 'declared_incident',
    )!;
    const stale = {
      ...base,
      id: 'INC-STALE',
      openedAt: '2026-07-26T12:00:00.000Z',
      matchScore: 1,
      status: 'stale status must not be quoted',
      statusUpdatedAt: '2026-07-26T12:15:00.000Z',
      summary: 'Stale declared incident',
      url: 'https://status.example.edu/incident/INC-STALE',
    };
    const fresh = {
      ...base,
      id: 'INC-FRESH',
      openedAt: '2026-07-28T11:45:00.000Z',
      matchScore: 0.9,
      status: 'fresh selected status',
      statusUpdatedAt: '2026-07-28T11:50:00.000Z',
      summary: 'Fresh declared incident',
      url: 'https://status.example.edu/incident/INC-FRESH',
    };
    h.incidents.search = async () => [stale, fresh];

    const response = await handleReport(
      { text: scenario.report.verbatim, identityRef: IDENTITY_REF, canFollowUp: false },
      h.deps,
    );

    expect(response.outcome).toBe('MATCHED_DECLARED');
    expect(response.incident).toEqual({
      id: 'INC-FRESH',
      status: fresh.status,
      statusUpdatedAt: fresh.statusUpdatedAt,
      url: fresh.url,
    });
    expect(response.override?.matchId).toBe('INC-FRESH');
    expect(response.reply).toContain(fresh.summary);
    expect(response.reply).toContain(fresh.status);
    expect(response.reply).not.toContain(stale.summary);
    expect(response.reply).not.toContain(stale.status);
    expect(h.tickets.filed).toHaveLength(0);
  });

  it('files when no declared incident qualifies and there is no peer cluster', async () => {
    const scenario = FLOWS.find((f) => f.id === 'F1')!;
    const h = harness(scenario.report);
    const base = scenario.world.candidates.find(
      (candidate): candidate is DeclaredIncident => candidate.kind === 'declared_incident',
    )!;
    h.incidents.search = async () => [
      {
        ...base,
        id: 'INC-STALE',
        openedAt: '2026-07-26T12:00:00.000Z',
        matchScore: 1,
        url: 'https://status.example.edu/incident/INC-STALE',
      },
      {
        ...base,
        id: 'INC-BELOW-THRESHOLD',
        openedAt: CORPUS_NOW,
        matchScore: TEST_GATE.matchScoreThreshold - 0.01,
        url: 'https://status.example.edu/incident/INC-BELOW-THRESHOLD',
      },
    ];

    const response = await handleReport(
      { text: scenario.report.verbatim, identityRef: IDENTITY_REF, canFollowUp: false },
      h.deps,
    );

    expect(response.outcome).toBe('FILED_INCIDENT');
    expect(response.incident).toBeUndefined();
    expect(h.tickets.filed).toHaveLength(1);
    expect(h.audit.lines.find((line) => line.action === 'decided')?.matchedId).toBe('');
  });

  it('MATCHED_CLUSTER carries source ticket links, never a status, and an override handle', async () => {
    const { response, tickets } = await runScenario(FLOWS.find((f) => f.id === 'F2')!);
    expect(tickets.filed).toHaveLength(0);
    expect(response.cluster?.reportCount).toBe(5);
    expect(response.cluster?.ticketIds).toHaveLength(5);
    expect(response.cluster?.tickets).toEqual(
      response.cluster?.ticketIds.map((ticketNumber) => ({
        ticketNumber,
        url: `https://it.example.edu/ticket/${ticketNumber}`,
      })),
    );
    expect(response.override?.matchId).toBe('REQ300');
    expect(response.incident).toBeUndefined();
    expect(response.ticket).toBeUndefined();
  });

  it('F13 — a failed search never falls through to filing', async () => {
    const { response, tickets, audit } = await runScenario(FLOWS.find((f) => f.id === 'F13')!);
    expect(response.outcome).toBe('UNAVAILABLE');
    expect(tickets.filed).toHaveLength(0);
    expect(audit.lines.some((l) => l.errorKind === 'incident_search_failed')).toBe(true);
    // And the reply still hands the user a human path.
    expect(response.reply).toContain('Service Desk');
  });

  it('F12 — a throttled report performs no search, files nothing, publishes nothing', async () => {
    const { response, tickets, stream, audit } = await runScenario(FLOWS.find((f) => f.id === 'F12')!);
    expect(response.outcome).toBe('THROTTLED');
    expect(tickets.filed).toHaveLength(0);
    expect(stream.events).toHaveLength(0);
    expect(audit.lines.some((l) => l.action === 'searched')).toBe(false);
    expect(audit.lines.some((l) => l.action === 'throttled')).toBe(true);
  });

  it('F9 — NEEDS_DETAIL asks rather than guessing, and performs no search', async () => {
    const { response, tickets, stream, audit } = await runScenario(FLOWS.find((f) => f.id === 'F9')!);
    expect(response.outcome).toBe('NEEDS_DETAIL');
    expect(response.missingFields).toContain('scope');
    expect(tickets.filed).toHaveLength(0);
    expect(stream.events).toHaveLength(0);
    expect(audit.lines.some((l) => l.action === 'searched')).toBe(false);
  });

  it('F11 — an override files anyway and writes the labelled overridden line', async () => {
    const { response, tickets, feedback, audit } = await runScenario(FLOWS.find((f) => f.id === 'F11')!);
    expect(response.outcome).toBe('FILED_INCIDENT');
    expect(tickets.filed[0].filedViaOverride).toBe(true);
    expect(tickets.filed[0].overriddenMatchId).toBe('REQ300');
    expect(feedback.overrides).toHaveLength(1);

    const line = audit.lines.find((l) => l.action === 'overridden');
    expect(line?.overriddenMatchId).toBe('REQ300');
    // The score that was wrong IS the training data (audit_log.md).
    expect(line?.overriddenScore).toBeGreaterThan(0);
  });
});

describe('audit invariants (audit_log.md)', () => {
  beforeEach(() => {
    resetGate();
    resetThrottle();
    configureGate(TEST_GATE);
    configureThrottle(TEST_THROTTLE);
  });

  it('a filed line is always preceded by a searched line for the same correlationId', async () => {
    for (const s of FLOWS) {
      const { audit } = await runScenario(s);
      const filed = audit.lines.findIndex((l) => l.action === 'filed');
      if (filed === -1) continue;
      const searched = audit.lines.findIndex(
        (l) => l.action === 'searched' && l.correlationId === audit.lines[filed].correlationId,
      );
      expect(searched, `${s.id}: filed without a preceding searched`).toBeGreaterThanOrEqual(0);
      expect(searched).toBeLessThan(filed);
    }
  });

  it('every decided line carries the four fields a threshold replay needs', async () => {
    const { audit } = await runScenario(FLOWS.find((f) => f.id === 'F3')!);
    const decided = audit.lines.find((l) => l.action === 'decided');
    expect(decided?.outcome).toBeDefined();
    expect(decided?.topMatchScore).toBeDefined();
    expect(decided?.withinWindow).toBeDefined();
    expect(decided?.clusterSize).toBeDefined();
    expect(decided?.clusterThreshold).toBe(5);
  });

  it('no raw identity appears in any line — reporterHash only', async () => {
    for (const s of FLOWS) {
      const { audit } = await runScenario(s);
      expect(audit.toJSONL()).not.toContain(IDENTITY_REF);
    }
  });
});

describe('ticket class is a pure function of scope (ticket_type_catalog.md)', () => {
  beforeEach(() => {
    resetGate();
    resetThrottle();
    configureGate(TEST_GATE);
    configureThrottle(TEST_THROTTLE);
  });

  it('every filed payload agrees with the catalog mapping — symptom never nudges it', async () => {
    for (const s of FLOWS) {
      const { tickets } = await runScenario(s);
      for (const p of tickets.filed) {
        expect(p.ticketClass, `${s.id}: class disagrees with scope ${p.scope}`).toBe(
          ticketClassFor(p.scope as TicketScope),
        );
      }
    }
  });
});
