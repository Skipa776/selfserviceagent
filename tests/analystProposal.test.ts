import { describe, expect, it } from 'vitest';

import type { AnalystEvidenceSnapshot } from '../src/analyst/contracts';
import { validateAnalystProposal } from '../src/analyst/proposal';

const snapshot: AnalystEvidenceSnapshot = {
  snapshotId: 'snap-1',
  generatedAt: '2026-09-11T12:05:00.000Z',
  topicKey: 'classroom_av|location|WLH||equipment_unavailable',
  service: 'classroom_av',
  scope: 'location',
  location: 'Lecture Hall West',
  building: 'WLH',
  room: '',
  symptom: 'equipment_unavailable',
  firstReportAt: '2026-09-11T12:00:00.000Z',
  lastReportAt: '2026-09-11T12:04:00.000Z',
  filedDistinct: 3,
  overflowDistinct: 2,
  overrideDistinct: 0,
  totalDistinct: 5,
  filedTicketNumbers: ['INC001', 'INC002', 'INC003'],
  evidence: [
    { id: 'E1', correlationId: 'corr-1', reporterHash: 'r1', outcome: 'FILE_INCIDENT', ticketNumber: 'INC001', viaOverride: false, ts: '2026-09-11T12:00:00.000Z' },
    { id: 'E2', correlationId: 'corr-2', reporterHash: 'r2', outcome: 'MATCHED_CLUSTER', ticketNumber: '', viaOverride: false, ts: '2026-09-11T12:04:00.000Z' },
  ],
};

const valid = {
  shortDescription: 'Projector unavailable in Lecture Hall West',
  description: 'Five distinct synthetic reporters described matching classroom AV failures.',
  recommendedImpact: '2',
  recommendedUrgency: '2',
  evidenceStrength: 'sufficient',
  rationale: 'The recommendation is based on five distinct reporters in one location.',
  citations: [
    { claim: 'Five distinct reporters are represented.', evidenceIds: ['E1', 'E2'] },
  ],
  splitRecommendation: { shouldSplit: false, evidenceIds: ['E1', 'E2'], rationale: 'The canonical topic is consistent.' },
};

describe('analyst proposal validation', () => {
  it('accepts a bounded proposal with citations from the snapshot', () => {
    const result = validateAnalystProposal(valid, snapshot);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.snapshotId).toBe(snapshot.snapshotId);
  });

  it.each(['priority', 'status', 'eta', 'assignmentGroup', 'createIncident'])('rejects extra authority field %s', (field) => {
    expect(validateAnalystProposal({ ...valid, [field]: 'unsafe' }, snapshot)).toEqual({
      ok: false,
      error: `unexpected field ${field}`,
    });
  });

  it('rejects citations outside the frozen snapshot', () => {
    const result = validateAnalystProposal({
      ...valid,
      citations: [{ claim: 'Unsupported evidence.', evidenceIds: ['E99'] }],
    }, snapshot);
    expect(result).toEqual({ ok: false, error: 'citation E99 is not in snapshot' });
  });

  it.each([
    'This is a confirmed outage.',
    'A major outage affects South Residence Hall.',
    'The campus network is unavailable.',
    'ITS is investigating and will restore service by 3 PM.',
    'Engineers are working on a fix.',
    'Support has been assigned.',
    'The vendor confirmed a hardware failure.',
  ])('rejects unsupported operational claim: %s', (description) => {
    const result = validateAnalystProposal({ ...valid, description }, snapshot);
    expect(result.ok).toBe(false);
  });

  it('rejects prohibited claims inside citations and split rationale', () => {
    expect(validateAnalystProposal({
      ...valid,
      citations: [{ claim: 'This is an outage.', evidenceIds: ['E1'] }],
    }, snapshot).ok).toBe(false);
    expect(validateAnalystProposal({
      ...valid,
      splitRecommendation: { shouldSplit: true, evidenceIds: ['E1'], rationale: 'ITS is investigating.' },
    }, snapshot).ok).toBe(false);
  });

  it('bounds model-authored text and citation counts', () => {
    expect(validateAnalystProposal({ ...valid, description: 'x'.repeat(2001) }, snapshot).ok).toBe(false);
    expect(validateAnalystProposal({ ...valid, citations: Array.from({ length: 21 }, () => valid.citations[0]) }, snapshot).ok).toBe(false);
  });

  it('requires evidence for a split recommendation', () => {
    expect(validateAnalystProposal({
      ...valid,
      splitRecommendation: { shouldSplit: true, evidenceIds: [], rationale: 'Two groups may exist.' },
    }, snapshot).ok).toBe(false);
  });

  it('rejects an invalid impact or urgency instead of inventing priority policy', () => {
    expect(validateAnalystProposal({ ...valid, recommendedImpact: '4' }, snapshot).ok).toBe(false);
    expect(validateAnalystProposal({ ...valid, recommendedUrgency: 'critical' }, snapshot).ok).toBe(false);
  });
});
