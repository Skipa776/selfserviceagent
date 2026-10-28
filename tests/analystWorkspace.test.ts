import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AnalystWorkspace } from '../src/analyst/workspace';
import type { ReportEvent } from '../src/contracts/types';
import type { ChatClient } from '../src/parser/chatClient';

const event = (overrides: Partial<ReportEvent> = {}): ReportEvent => ({
  ts: '2026-09-11T12:00:00.000Z', correlationId: 'corr-1', service: 'classroom_av', scope: 'location',
  location: 'Lecture Hall West', building: 'LHW', room: '', symptom: 'equipment_unavailable', observedAt: '',
  reporterHash: 'reporter-a', outcome: 'FILE_INCIDENT', ticketNumber: 'INC001', viaOverride: false,
  ...overrides,
});

const response = JSON.stringify({
  shortDescription: 'Projector unavailable in Lecture Hall West',
  description: 'Several distinct synthetic reporters described matching classroom AV failures.',
  recommendedImpact: '2', recommendedUrgency: '2', evidenceStrength: 'sufficient',
  rationale: 'The recommendation uses the clustered evidence.',
  citations: [{ claim: 'The cluster contains matching reports.', evidenceIds: ['E1'] }],
  splitRecommendation: { shouldSplit: false, evidenceIds: ['E1'], rationale: 'The evidence has one canonical topic.' },
});

const workspaces: AnalystWorkspace[] = [];
const tempDirectories: string[] = [];
afterEach(() => {
  workspaces.splice(0).forEach((workspace) => workspace.close());
  tempDirectories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

describe('shadow analyst workspace', () => {
  it('ingests only new stream events and exposes aggregate snapshots', () => {
    const client: ChatClient = { complete: async () => response };
    const workspace = new AnalystWorkspace(':memory:', client, () => new Date('2026-09-11T12:05:00.000Z'));
    workspaces.push(workspace);
    workspace.ingest([event(), event({ correlationId: 'corr-2', reporterHash: 'reporter-b', ticketNumber: 'INC002' })]);
    workspace.ingest([event(), event({ correlationId: 'corr-2', reporterHash: 'reporter-b', ticketNumber: 'INC002' })]);
    expect(workspace.snapshots()[0]).toMatchObject({ filedDistinct: 2, totalDistinct: 2 });
  });

  it('generates and approves a proposal without creating a ServiceNow ticket', async () => {
    const client: ChatClient = { complete: async () => response };
    const workspace = new AnalystWorkspace(':memory:', client, () => new Date('2026-09-11T12:05:00.000Z'));
    workspaces.push(workspace);
    workspace.ingest([event()]);
    const snapshot = workspace.snapshots()[0];
    const proposed = await workspace.generate(snapshot.snapshotId);
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    const approval = workspace.approve(snapshot.snapshotId, proposed.digest, 'synthetic-demo-operator');
    expect(approval.ok).toBe(true);
    if (approval.ok) expect(approval.value.mode).toBe('shadow');
    expect(workspace.status().serviceNowCreationEnabled).toBe(false);
  });

  it('rejects approval until a valid proposal exists', () => {
    const client: ChatClient = { complete: async () => response };
    const workspace = new AnalystWorkspace(':memory:', client);
    workspaces.push(workspace);
    workspace.ingest([event()]);
    const snapshot = workspace.snapshots()[0];
    expect(workspace.approve(snapshot.snapshotId, 'missing', 'synthetic-demo-operator')).toEqual({
      ok: false,
      error: 'proposal_not_found',
    });
  });

  it('rejects approval when the displayed proposal digest is stale', async () => {
    const client: ChatClient = { complete: async () => response };
    const workspace = new AnalystWorkspace(':memory:', client);
    workspaces.push(workspace);
    workspace.ingest([event()]);
    const snapshot = workspace.snapshots()[0];
    const proposed = await workspace.generate(snapshot.snapshotId);
    expect(proposed.ok).toBe(true);
    expect(workspace.approve(snapshot.snapshotId, 'wrong-digest', 'synthetic-demo-operator')).toEqual({
      ok: false,
      error: 'proposal_changed',
    });
  });

  it('persists proposals and approvals across a process restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'analyst-workspace-'));
    tempDirectories.push(directory);
    const path = join(directory, 'analyst.sqlite');
    const client: ChatClient = { complete: async () => response };
    const first = new AnalystWorkspace(path, client, () => new Date('2026-09-11T12:05:00.000Z'));
    first.ingest([event()]);
    const snapshot = first.snapshots()[0];
    const proposed = await first.generate(snapshot.snapshotId);
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(first.approve(snapshot.snapshotId, proposed.digest, 'synthetic-demo-operator').ok).toBe(true);
    first.close();

    const second = new AnalystWorkspace(path, client, () => new Date('2026-09-11T12:06:00.000Z'));
    workspaces.push(second);
    expect(second.proposal(snapshot.snapshotId)).not.toBeNull();
    expect(second.status().approvals).toBe(1);
  });
});
