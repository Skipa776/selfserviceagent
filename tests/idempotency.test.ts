import { beforeEach, describe, expect, it } from 'vitest';

import { configureGate, resetGate } from '../src/clusterGate';
import type { ProblemReport } from '../src/contracts/types';
import { handleReport } from '../src/orchestrator';
import { configureThrottle, resetThrottle } from '../src/throttleLimits';
import { harness, IDENTITY_REF, TEST_GATE, TEST_THROTTLE } from './harness';

const REPORT: ProblemReport = {
  service: 'wifi',
  scope: 'location',
  location: 'North Residence Hall',
  building: 'NORTH RESIDENCE HALL',
  room: '',
  symptom: 'intermittent',
  observedAt: '',
  verbatim: 'the wifi in North Residence Hall keeps dropping',
};

const request = (overrideMatchId?: string) => ({
  text: REPORT.verbatim,
  identityRef: IDENTITY_REF,
  canFollowUp: true,
  ...(overrideMatchId === undefined ? {} : { overrideMatchId }),
});

beforeEach(() => {
  resetGate();
  resetThrottle();
  configureGate(TEST_GATE);
  configureThrottle(TEST_THROTTLE);
});

describe('in-flight idempotency', () => {
  it('coalesces concurrent identical reports into one lifecycle', async () => {
    const h = harness(REPORT);
    const create = h.tickets.createTicket.bind(h.tickets);
    let createCalls = 0;
    let signalCreateStarted!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      signalCreateStarted = resolve;
    });
    let releaseCreate!: () => void;
    const createReleased = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    h.tickets.createTicket = async (payload) => {
      createCalls += 1;
      signalCreateStarted();
      await createReleased;
      return create(payload);
    };

    const responses = Promise.all([handleReport(request(), h.deps), handleReport(request(), h.deps)]);
    await createStarted;
    const callsWhileBlocked = createCalls;
    releaseCreate();
    const [first, second] = await responses;

    expect(callsWhileBlocked).toBe(1);
    expect(second).toEqual(first);
    expect(second.ticket?.ticketNumber).toBe(first.ticket?.ticketNumber);
    expect(h.tickets.filed).toHaveLength(1);
    expect(h.stream.events).toHaveLength(1);
    expect(h.audit.lines.filter((line) => line.action === 'filed')).toHaveLength(1);
  });

  it('does not coalesce concurrent overrides', async () => {
    const h = harness(REPORT);
    const create = h.tickets.createTicket.bind(h.tickets);
    let createCalls = 0;
    let signalBothCreatesStarted!: () => void;
    const bothCreatesStarted = new Promise<void>((resolve) => {
      signalBothCreatesStarted = resolve;
    });
    let releaseCreate!: () => void;
    const createReleased = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    h.tickets.createTicket = async (payload) => {
      createCalls += 1;
      if (createCalls === 2) signalBothCreatesStarted();
      await createReleased;
      return create(payload);
    };

    const responses = Promise.all([
      handleReport(request('REQ300'), h.deps),
      handleReport(request('REQ300'), h.deps),
    ]);
    await bothCreatesStarted;
    const callsWhileBlocked = createCalls;
    releaseCreate();
    const [first, second] = await responses;

    expect(callsWhileBlocked).toBe(2);
    expect(first.ticket?.ticketNumber).not.toBe(second.ticket?.ticketNumber);
    expect(h.tickets.filed).toHaveLength(2);
    expect(h.stream.events).toHaveLength(2);
    expect(h.feedback.overrides).toHaveLength(2);
    expect(h.audit.lines.filter((line) => line.action === 'filed')).toHaveLength(2);
  });

  it('cleans up after an unavailable result so a later retry can run', async () => {
    const h = harness(REPORT);
    const search = h.incidents.search.bind(h.incidents);
    let searchCalls = 0;
    let signalSearchStarted!: () => void;
    const searchStarted = new Promise<void>((resolve) => {
      signalSearchStarted = resolve;
    });
    let releaseSearch!: () => void;
    const searchReleased = new Promise<void>((resolve) => {
      releaseSearch = resolve;
    });
    h.incidents.search = async (query) => {
      searchCalls += 1;
      if (searchCalls === 1) {
        signalSearchStarted();
        await searchReleased;
      }
      if (searchCalls <= 2) throw new Error('incident source unreachable');
      return search(query);
    };

    const concurrent = Promise.all([handleReport(request(), h.deps), handleReport(request(), h.deps)]);
    await searchStarted;
    releaseSearch();
    const first = await concurrent;

    expect(first.map((response) => response.outcome)).toEqual(['UNAVAILABLE', 'UNAVAILABLE']);
    expect(searchCalls).toBe(2);

    const retry = await handleReport(request(), h.deps);
    expect(retry.outcome).toBe('FILED_INCIDENT');
    expect(searchCalls).toBe(3);
    expect(h.tickets.filed).toHaveLength(1);
  });

  it('cleans up after a rejected lifecycle so a later retry can run', async () => {
    const h = harness(REPORT);
    const record = h.limiter.record.bind(h.limiter);
    let recordCalls = 0;
    h.limiter.record = async (hash, report) => {
      recordCalls += 1;
      if (recordCalls === 1) throw new Error('rate limiter unavailable');
      return record(hash, report);
    };

    const concurrent = await Promise.allSettled([
      handleReport(request(), h.deps),
      handleReport(request(), h.deps),
    ]);

    expect(concurrent.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(recordCalls).toBe(1);

    const retry = await handleReport(request(), h.deps);
    expect(retry.outcome).toBe('FILED_INCIDENT');
    expect(recordCalls).toBe(2);
    expect(h.tickets.filed).toHaveLength(1);
  });
});
