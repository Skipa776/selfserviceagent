import { describe, expect, it } from 'vitest';
import { BUILDINGS, canonicalBuilding, canonicalLocation, canonicalRoom, extractRoom, matchBuilding } from '../src/vocab/locations';
import { parseReport } from '../src/parser/reportParser';

describe('campus location boundary', () => {
  it('canonicalizes official aliases and codes', () => {
    expect(canonicalBuilding('S&E')).toBe('SEB');
    expect(canonicalBuilding('Main Library')).toBe('LIB');
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
    expect(matchBuilding('projector in the Lecture Hall')?.building.code).toBe('LECT');
    expect(matchBuilding('the lecturer network')).toBeNull();
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
    expect(extractRoom('LECT 214', 'LECT 214'.indexOf('LECT') + 4)).toBe('214');
    expect(parseReport('projector in Lecture Hall room 214 will not turn on')).toMatchObject({ building: 'LECT', room: '214' });
  });

  it('does not classify ordinary prose aliases as buildings', () => {
    for (const text of ['a beacon of hope', 'summit at noon', 'harbor a grudge', 'the meridian line', 'Lantern festival tonight']) {
      expect(parseReport(text).building).toBe('');
    }
  });

  it('does not create generated locations from Lecture Hall text', () => {
    expect(parseReport('projector in Lecture Hall will not turn on')).toMatchObject({
      location: 'Lecture Hall', building: 'LECT', room: '',
    });
  });
});
