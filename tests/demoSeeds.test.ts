import { describe, expect, it } from 'vitest';

import { scoreCandidate } from '../src/adapters/scoring';
import { postReport } from '../src/api';
import { buildStage1 } from '../src/composition';
import type { PeerTicket } from '../src/contracts/types';
import { canonicalSeedBuilding } from '../src/demoSeeds';
import { parseReport } from '../src/parser/reportParser';

function seededPeer(
  fields: Pick<PeerTicket, 'service' | 'scope' | 'locations' | 'symptom'>,
  id = 'DEMO001',
): PeerTicket {
  return {
    kind: 'peer_ticket',
    id,
    ...fields,
    building: canonicalSeedBuilding(fields),
    room: '',
    openedAt: '2026-07-28T12:00:00.000Z',
    matchScore: 0,
    reporterHash: 'synthetic-reporter',
    url: 'https://tickets.example.edu/DEMO001',
  };
}

describe('runtime demo seed records', () => {
  it.each([
    {
      text: 'the wifi in North Residence Hall keeps dropping',
      fields: { service: 'wifi', scope: 'location', locations: ['North Residence Hall'], symptom: 'intermittent' },
      expectedBuilding: 'NORTH RESIDENCE HALL',
    },
    {
      text: 'the projector in Lecture Hall will not turn on',
      fields: { service: 'classroom_av', scope: 'location', locations: ['Lecture Hall'], symptom: 'equipment_unavailable' },
      expectedBuilding: 'LECT',
    },
  ] as const)('canonicalizes $fields.locations and scores against its parsed report', ({ text, fields, expectedBuilding }) => {
    const report = parseReport(text);
    const peer = seededPeer(fields);

    expect(peer.building).toBe(expectedBuilding);
    expect(report.building).toBe(expectedBuilding);
    expect(scoreCandidate({
      service: report.service,
      scope: report.scope,
      location: report.location,
      building: report.building,
      room: report.room,
      symptom: report.symptom,
    }, peer)).toBe(1);
  });

  it('deflects the sixth seeded North Residence Hall wifi report as MATCHED_CLUSTER', async () => {
    const system = buildStage1({ clock: () => new Date('2026-07-28T12:00:00.000Z') });
    const fields = { service: 'wifi', scope: 'location', locations: ['North Residence Hall'], symptom: 'intermittent' } as const;

    system.incidents.seed(Array.from({ length: 5 }, (_, index) => ({
      ...seededPeer(fields, `DEMO00${index + 1}`),
      reporterHash: `synthetic-reporter-${index + 1}`,
    })));

    const { body } = await postReport({
      text: 'the wifi in North Residence Hall keeps dropping',
      identityRef: 'demo-student-6',
      canFollowUp: true,
    }, system.deps);

    expect(body.outcome).toBe('MATCHED_CLUSTER');
  });
});
