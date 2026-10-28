// Synthetic campus location boundary. Building names and codes are fictional
// and do not describe any real campus.

export type Building = {
  readonly code: string;
  readonly name: string;
  readonly aliases: readonly string[];
};

export const BUILDINGS: readonly Building[] = [
  { code: 'SEB', name: 'Science and Engineering Building', aliases: ['S&E', 'SEB'] },
  { code: 'LECT', name: 'Lecture Hall', aliases: ['Lecture Hall', 'LECT'] },
  { code: 'CONF', name: 'Conference Center', aliases: ['Conference Center', 'CONF'] },
  { code: 'BCN', name: 'Beacon', aliases: ['BCN', 'Beacon Building'] },
  { code: 'PSYB', name: 'Psychology Building', aliases: ['Psychology Building', 'PSYB'] },
  { code: 'SMT', name: 'Summit', aliases: ['SMT', 'Summit Building'] },
  { code: 'ENGR', name: 'Engineering Hall', aliases: ['Engineering Hall', 'ENGR'] },
  { code: 'HUMN', name: 'Humanities Building', aliases: ['Humanities Building', 'HUMN'] },
  { code: 'AUD', name: 'Main Auditorium', aliases: ['Main Auditorium', 'AUD'] },
  { code: 'OAKLY', name: 'Dana C. Oakley Hall', aliases: ['Dana C. Oakley Hall', 'Oakley Hall', 'OAKLY'] },
  { code: 'ARTC', name: 'Arts Center', aliases: ['Arts Center', 'ARTC'] },
  { code: 'MAPL', name: 'Maple Hall', aliases: ['Maple Hall', 'MAPL'] },
  { code: 'MRD', name: 'Meridian', aliases: ['MRD', 'Meridian Building'] },
  { code: 'CDRH', name: 'Cedar Hall', aliases: ['Cedar Hall', 'CDRH'] },
  { code: 'PINEH', name: 'Pine Hall', aliases: ['Pine Hall', 'PINEH'] },
  { code: 'HRB', name: 'Harbor', aliases: ['HRB', 'Harbor Building'] },
  { code: 'STUC', name: 'Student Center', aliases: ['Student Center', 'STUC'] },
  { code: 'WB2', name: 'West Building 2 - Auditorium', aliases: ['West Building 2', 'West Building 2 - Auditorium', 'WB2'] },
  { code: 'HAB', name: 'Hillside Academic Building', aliases: ['Hillside Academic Building', 'HAB'] },
  { code: 'BRCH', name: 'Birch Hall', aliases: ['Birch Hall', 'BRCH'] },
  { code: 'SSB', name: 'Social Sciences Building', aliases: ['Social Sciences Building', 'SSB'] },
  { code: 'LHW', name: 'Lecture Hall West', aliases: ['Lecture Hall West', 'LHW'] },
  { code: 'ELMH', name: 'Elm Hall', aliases: ['Elm Hall', 'ELMH'] },
  { code: 'INNOV', name: 'Innovation Building', aliases: ['Innovation Building', 'INNOV'] },
  { code: 'LNTN', name: 'The Lantern', aliases: ['The Lantern', 'LNTN'] },
  { code: 'LIB', name: 'Main Library', aliases: ['Main Library', 'LIB'] },
] as const;

export const AREA_TOKENS = ['North Residence Hall', 'South Residence Hall'] as const;
export type AreaToken = (typeof AREA_TOKENS)[number];

const normalizeSpaces = (value: string): string => value.trim().replace(/\s+/g, ' ');

export function normalizeLocationAlias(value: string): string {
  return normalizeSpaces(value).toLocaleLowerCase('en-US').replace(/[.]/g, '');
}

function boundaryMatch(text: string, alias: string): RegExpExecArray | null {
  return new RegExp(`(^|[^a-z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^a-z0-9])`, 'i').exec(text);
}

export type BuildingMatch = { readonly building: Building; readonly start: number; readonly end: number };

export function matchBuilding(text: string): BuildingMatch | null {
  const matches: BuildingMatch[] = [];
  for (const building of BUILDINGS) {
    for (const alias of building.aliases) {
      const found = boundaryMatch(text, alias);
      if (found) {
        const start = found.index + found[1].length;
        matches.push({ building, start, end: start + alias.length });
      }
    }
  }
  return matches.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start)[0] ?? null;
}

function exactBuilding(value: string): Building | undefined {
  const key = normalizeLocationAlias(value);
  return BUILDINGS.find((building) =>
    normalizeLocationAlias(building.name) === key ||
    building.aliases.some((alias) => normalizeLocationAlias(alias) === key),
  );
}

export function matchArea(text: string): AreaToken | '' {
  const matches = AREA_TOKENS.filter((area) => boundaryMatch(text, area));
  return matches[0] ?? '';
}

export function extractRoom(text: string, after = 0): string {
  const tail = text.slice(after);
  const explicit = /\b(?:room|rm)\s*([A-Z]?\d{1,4}[A-Z]?)\b/i.exec(tail);
  const adjacent = after > 0 ? /^\s+([A-Z]?\d{2,4}[A-Z]?)\b/i.exec(tail) : null;
  const compact = after > 0 ? /\b([A-Z]{2,6})\s+([A-Z]?\d{2,4}[A-Z]?)\b/i.exec(tail) : null;
  if (after === 0 && explicit === null) return '';
  const value = explicit?.[1] ?? adjacent?.[1] ?? compact?.[2] ?? '';
  return value.toUpperCase();
}

export function canonicalBuilding(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = normalizeSpaces(value);
  const key = normalizeLocationAlias(normalized);
  if (key === 'north residence hall') return 'NORTH RESIDENCE HALL';
  if (key === 'south residence hall') return 'SOUTH RESIDENCE HALL';
  return exactBuilding(normalized)?.code ?? '';
}

export function canonicalLocation(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = normalizeSpaces(value);
  const exact = exactBuilding(normalized);
  if (exact) return exact.name;
  const match = matchBuilding(value);
  if (match) return match.building.name;
  return matchArea(value);
}

export function canonicalRoom(value: unknown): string {
  if (typeof value !== 'string') return '';
  const room = (value.match(/[A-Z]?\d{1,4}[A-Z]?/i)?.[0] ?? '').toUpperCase();
  return /^[A-Z]?\d{1,4}[A-Z]?$/.test(room) ? room : '';
}
