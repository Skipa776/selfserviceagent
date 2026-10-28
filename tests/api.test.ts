// contracts/api_contract.md — the boundary two callers we do not control
// integrate against.
//
// The contract's own verification note asks for one flow test per outcome value
// plus a contract test asserting the mutual exclusivity of incident/cluster/ticket
// and the presence of `override` on every deflect. That is this file.

import { beforeEach, describe, expect, it } from 'vitest';

import { normalizeRequest, postReport, statusFor } from '../src/api';
import { configureGate, resetGate } from '../src/clusterGate';
import type { ApiOutcome } from '../src/contracts/types';
import { configureThrottle, resetThrottle } from '../src/throttleLimits';
import { FLOWS } from './corpus';
import { harness, IDENTITY_REF, TEST_GATE, TEST_THROTTLE } from './harness';

beforeEach(() => {
  resetGate();
  resetThrottle();
  configureGate(TEST_GATE);
  configureThrottle(TEST_THROTTLE);
});

describe('the request boundary is untrusted input, like every other boundary here', () => {
  it('coerces any malformed body into a clean request rather than throwing', () => {
    for (const bad of [null, undefined, 42, 'a string', [], { text: 99 }]) {
      const r = normalizeRequest(bad);
      expect(typeof r.text).toBe('string');
      expect(r.identityRef).not.toBe('');
      expect(typeof r.canFollowUp).toBe('boolean');
    }
  });

  it('defaults canFollowUp to true — asking beats filing junk from an empty body', () => {
    expect(normalizeRequest({ text: 'hi' }).canFollowUp).toBe(true);
    expect(normalizeRequest({ text: 'hi', canFollowUp: false }).canFollowUp).toBe(false);
    expect(normalizeRequest({ text: 'hi', canFollowUp: 'yes' }).canFollowUp).toBe(true);
  });

  it('drops an empty overrideMatchId rather than treating it as an override', () => {
    expect(normalizeRequest({ overrideMatchId: '' }).overrideMatchId).toBeUndefined();
    expect(normalizeRequest({ overrideMatchId: 'REQ300' }).overrideMatchId).toBe('REQ300');
  });

  it('a garbage body still produces one of the seven outcomes, never a throw', async () => {
    const h = harness({
      service: 'unknown',
      scope: 'unknown',
      location: '',
      building: '',
      room: '',
      symptom: 'unknown',
      observedAt: '',
      verbatim: '',
    });
    const { status, body } = await postReport({ nonsense: true }, h.deps);
    expect(body.outcome).toBe('NEEDS_DETAIL');
    expect(status).toBe(200);
    expect(body.reply.length).toBeGreaterThan(0);
  });
});

describe('status codes', () => {
  it('maps degraded outcomes to codes a caller can retry on', () => {
    expect(statusFor('THROTTLED')).toBe(429);
    expect(statusFor('UNAVAILABLE')).toBe(503);
    for (const ok of ['MATCHED_DECLARED', 'MATCHED_CLUSTER', 'FILED_INCIDENT', 'FILED_REQUEST', 'NEEDS_DETAIL'] as const) {
      expect(statusFor(ok)).toBe(200);
    }
  });
});

describe('the response shape is mutually exclusive BY CONSTRUCTION', () => {
  it('over every flow scenario, no response mixes a match with a ticket', async () => {
    const seen = new Set<ApiOutcome>();

    for (const s of FLOWS) {
      const h = harness(s.report);
      h.incidents.seed(s.world.candidates);
      if (s.world.searchFails === true) h.incidents.failTimes = Number.POSITIVE_INFINITY;
      if (s.world.throttled === true) {
        const { hash } = await h.deps.identity.resolve(IDENTITY_REF);
        for (let i = 0; i < TEST_THROTTLE.maxReportsPerIdentity; i++) await h.limiter.record(hash, s.report);
      }

      const { body } = await postReport(
        {
          text: s.report.verbatim,
          identityRef: IDENTITY_REF,
          canFollowUp: s.world.canFollowUp,
          overrideMatchId: s.world.overrideMatchId,
        },
        h.deps,
      );
      seen.add(body.outcome);

      const isMatch = body.outcome === 'MATCHED_DECLARED' || body.outcome === 'MATCHED_CLUSTER';
      const isFiled = body.outcome === 'FILED_INCIDENT' || body.outcome === 'FILED_REQUEST';

      if (isMatch) {
        // The dedup outcome creates nothing — that is what the phrase means.
        expect(body.ticket, `${s.id}`).toBeUndefined();
        // And the affordance is never omitted as a UI simplification.
        expect(body.override?.matchId, `${s.id}`).toBeTruthy();
      }
      if (isFiled) {
        expect(body.incident, `${s.id}`).toBeUndefined();
        expect(body.cluster, `${s.id}`).toBeUndefined();
        expect(body.ticket?.ticketNumber, `${s.id}`).toBeTruthy();
      }
      if (body.outcome === 'MATCHED_DECLARED') expect(body.cluster).toBeUndefined();
      if (body.outcome === 'MATCHED_CLUSTER') {
        expect(body.incident).toBeUndefined();
        expect(body.cluster?.tickets.length, `${s.id}`).toBe(body.cluster?.ticketIds.length);
        for (const [index, ticket] of (body.cluster?.tickets ?? []).entries()) {
          expect(ticket.ticketNumber, `${s.id}`).toBe(body.cluster?.ticketIds[index]);
          expect(ticket.url, `${s.id}`).toBe(s.world.candidates.filter((candidate) => candidate.kind === 'peer_ticket')[index]?.url);
        }
      }
      if (body.outcome === 'NEEDS_DETAIL') expect(body.missingFields?.length).toBeGreaterThan(0);
      // No path returns an empty reply.
      expect(body.reply.length, `${s.id}`).toBeGreaterThan(0);
    }

    // The corpus exercises six of the seven; FILED_REQUEST arrives via F7/F10.
    expect(seen.has('MATCHED_DECLARED')).toBe(true);
    expect(seen.has('MATCHED_CLUSTER')).toBe(true);
    expect(seen.has('FILED_INCIDENT')).toBe(true);
    expect(seen.has('FILED_REQUEST')).toBe(true);
    expect(seen.has('NEEDS_DETAIL')).toBe(true);
    expect(seen.has('THROTTLED')).toBe(true);
    expect(seen.has('UNAVAILABLE')).toBe(true);
  });
});
