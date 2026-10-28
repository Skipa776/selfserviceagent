import { describe, expect, it } from 'vitest';

import type { AnalystProposal } from '../src/analyst/contracts';
import { ShadowApprovalStore, canonicalApprovalDigest } from '../src/analyst/approval';

const proposal: AnalystProposal = {
  snapshotId: 'snap-1',
  shortDescription: 'Projector unavailable in Lecture Hall West',
  description: 'Five distinct synthetic reporters described matching classroom AV failures.',
  recommendedImpact: '2',
  recommendedUrgency: '2',
  evidenceStrength: 'sufficient',
  rationale: 'The recommendation is based on five distinct reporters.',
  citations: [{ claim: 'Five reporters are represented.', evidenceIds: ['E1'] }],
  splitRecommendation: { shouldSplit: false, evidenceIds: ['E1'], rationale: 'One topic is represented.' },
};

describe('shadow analyst approval', () => {
  it('digests canonical proposal content deterministically', () => {
    expect(canonicalApprovalDigest(proposal)).toBe(canonicalApprovalDigest({ ...proposal }));
    expect(canonicalApprovalDigest({ ...proposal, recommendedUrgency: '1' })).not.toBe(canonicalApprovalDigest(proposal));
  });

  it('records one idempotent shadow approval and creates no ticket', () => {
    const store = new ShadowApprovalStore(() => new Date('2026-09-11T12:10:00.000Z'));
    const first = store.approve(proposal, 'synthetic-operator');
    const second = store.approve(proposal, 'synthetic-operator');

    expect(second).toEqual(first);
    expect(store.records).toHaveLength(1);
    expect(first).toMatchObject({ mode: 'shadow', approver: 'synthetic-operator', snapshotId: 'snap-1' });
    expect(first).not.toHaveProperty('ticketNumber');
  });
});
