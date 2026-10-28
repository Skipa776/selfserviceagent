import type { PeerTicket } from './contracts/types';
import { canonicalBuilding } from './vocab/locations';

export type SeedPeerFields = Pick<PeerTicket, 'service' | 'scope' | 'locations' | 'symptom'>;

/** Fixture/readback records use source display locations but matcher-owned codes. */
export function canonicalSeedBuilding(fields: SeedPeerFields): string {
  return canonicalBuilding(fields.locations[0] ?? '');
}
