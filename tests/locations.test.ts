import { describe, expect, it } from 'vitest';
import { BUILDINGS, canonicalBuilding, canonicalLocation, canonicalRoom, extractRoom, matchBuilding } from '../src/vocab/locations';
import { parseReport } from '../src/parser/reportParser';

describe('campus location boundary', () => {
  it('canonicalizes official aliases and codes', () => {
    expect(canonicalBuilding('AP&M')).toBe('APM');
    expect(canonicalBuilding('Main Library')).toBe('GEISEL');
    expect(canonicalLocation('North Residence Hall')).toBe('North Residence Hall');
  });

  it('is idempotent for every curated canonical display name and alias', () => {
    for (const building of BUILDINGS) {
      const expectedLocation = building.name === 'Main Library' ? 'Main Library' : building.name;
      expect(canonicalLocation(building.name)).toBe(expectedLocation);
      expect(canonicalBuilding(building.name)).toBe(building.code);
      for (const alias of building.aliases) {
        expect(canonicalLocation(alias)).toBe(expectedLocation);
        expect(canonicalBuilding(alias)).toBe(building.code);
      }
    }
  });

  it('matches aliases on boundaries', () => {
    expect(matchBuilding('projector in the Lecture Hall')?.building.code).toBe('CENTR');
    expect(matchBuilding('the centric network')).toBeNull();
  });

  it('extracts and canonicalizes room tokens', () => {
    expect(extractRoom('Lecture Hall room 101')).toBe('101');
    expect(canonicalRoom(' south residence hall 200 ')).toBe('200');
  });

  it('does not turn arbitrary numbers into rooms', () => {
    expect(extractRoom('since 2024')).toBe('');
    expect(extractRoom('in 2019')).toBe('');
    expect(extractRoom('error 404')).toBe('');
  });

  it('accepts a building-context code and explicit full-name room', () => {
    expect(extractRoom('CENTR 214', 'CENTR 214'.indexOf('CENTR') + 5)).toBe('214');
    expect(parseReport('projector in Lecture Hall room 214 will not turn on')).toMatchObject({ building: 'CENTR', room: '214' });
  });

  it('does not classify ordinary prose aliases as buildings', () => {
    for (const text of ['the coalition voted today', 'catalyst for change', 'a mosaic pattern', 'Podemos discuss it', 'Jeannie called']) {
      expect(parseReport(text).building).toBe('');
    }
  });

  it('does not create generated locations from Lecture Hall text', () => {
    expect(parseReport('projector in Lecture Hall will not turn on')).toMatchObject({
      location: 'Lecture Hall', building: 'CENTR', room: '',
    });
  });
});
