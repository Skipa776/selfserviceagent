import { afterEach, describe, expect, it } from 'vitest';

import { AnalystWorkspace } from '../src/analyst/workspace';
import type { ReportEvent } from '../src/contracts/types';
import type { ChatClient } from '../src/parser/chatClient';

const response = JSON.stringify({
  shortDescription: 'Projector unavailable in Lecture Hall West',
  description: 'Three distinct synthetic reporters described matching classroom AV failures.',
  recommendedImpact: '2', recommendedUrgency: '2', evidenceStrength: 'sufficient',
  rationale: 'Three reports share one canonical topic.',
  citations: [{ claim: 'Reports share one canonical topic.', evidenceIds: ['E1'] }],
  splitRecommendation: { shouldSplit: false, evidenceIds: ['E1'], rationale: 'No separate topic is represented.' },
});

const event = (correlationId: string, reporterHash: string): ReportEvent => ({
  ts: '2026-09-11T12:00:00.000Z', correlationId, service: 'classroom_av', scope: 'location',
  location: 'Lecture Hall West', building: 'WLH', room: '', symptom: 'equipment_unavailable', observedAt: '',
  reporterHash, outcome: 'FILE_INCIDENT', ticketNumber: `INC-${correlationId}`, viaOverride: false,
});

let workspace: AnalystWorkspace | null = null;
afterEach(() => workspace?.close());

describe('local shared tracking ticket', () => {
  it('creates one synthetic shared ticket from an exact approved proposal', async () => {
    const client: ChatClient = { complete: async () => response };
    workspace = new AnalystWorkspace(':memory:', client, () => new Date('2026-09-11T12:05:00.000Z'));
    workspace.ingest([event('c1', 'r1'), event('c2', 'r2'), event('c3', 'r3')]);
    const snapshot = workspace.snapshots()[0];
    const proposal = await workspace.generate(snapshot.snapshotId);
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;

    const approved = workspace.approve(snapshot.snapshotId, proposal.digest, 'synthetic-demo-operator');
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.sharedTicket).toMatchObject({
      ticketNumber: 'SHARED-DEMO-0001',
      topicKey: snapshot.topicKey,
      shortDescription: 'Projector unavailable in Lecture Hall West',
      mode: 'local-demo',
    });
    expect(workspace.sharedTickets()).toHaveLength(1);
  });

  it('returns the same ticket for a later report with the canonical topic', async () => {
    const client: ChatClient = { complete: async () => response };
    workspace = new AnalystWorkspace(':memory:', client);
    workspace.ingest([event('c1', 'r1')]);
    const snapshot = workspace.snapshots()[0];
    const proposal = await workspace.generate(snapshot.snapshotId);
    if (!proposal.ok) throw new Error('proposal failed');
    const approved = workspace.approve(snapshot.snapshotId, proposal.digest, 'synthetic-demo-operator');
    if (!approved.ok) throw new Error('approval failed');

    expect(workspace.matchSharedTicket({
      service: 'classroom_av', scope: 'location', location: 'Lecture Hall West', building: 'WLH', room: '',
      symptom: 'equipment_unavailable', observedAt: '', verbatim: 'wonky words',
    })?.ticketNumber).toBe(approved.sharedTicket.ticketNumber);
    expect(workspace.matchSharedTicket({
      service: 'classroom_av', scope: 'location', location: 'Lecture Hall', building: 'CENTR', room: '',
      symptom: 'equipment_unavailable', observedAt: '', verbatim: 'different place',
    })).toBeNull();
  });
});
