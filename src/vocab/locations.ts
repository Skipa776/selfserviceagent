// Canonical campus location boundary. This is curated from the public-source
// inventory; the inventory itself is provenance only and is never parsed here.

export type Building = {
  readonly code: string;
  readonly name: string;
  readonly aliases: readonly string[];
};

export const BUILDINGS: readonly Building[] = [
  { code: 'APM', name: 'Applied Physics and Mathematics', aliases: ['AP&M', 'APM'] },
  { code: 'CENTR', name: 'Lecture Hall', aliases: ['Lecture Hall', 'CENTR'] },
  { code: 'CICC', name: 'Copley International Conference Center', aliases: ['Copley International Conference Center', 'CICC'] },
  { code: 'COA', name: 'Coalition', aliases: ['COA', 'Coalition Building'] },
  { code: 'CSB', name: 'Cognitive Science Building', aliases: ['Cognitive Science Building', 'CSB'] },
  { code: 'CTL', name: 'Catalyst', aliases: ['CTL', 'Catalyst Building'] },
  { code: 'FAH', name: 'Franklin Antonio Hall', aliases: ['Franklin Antonio Hall', 'FAH'] },
  { code: 'HSS', name: 'Humanities and Social Sciences', aliases: ['Humanities and Social Sciences', 'HSS'] },
  { code: 'LEDDN', name: 'Ledden Auditorium', aliases: ['Ledden Auditorium', 'LEDDN'] },
  { code: 'MALK', name: 'Brian C. Malk Hall', aliases: ['Brian C. Malk Hall', 'Malk Hall', 'MALK'] },
  { code: 'MANDE', name: 'Mandeville Center', aliases: ['Mandeville Center', 'MANDE'] },
  { code: 'MCGIL', name: 'McGill Hall', aliases: ['McGill Hall', 'MCGIL'] },
  { code: 'MOS', name: 'Mosaic', aliases: ['MOS', 'Mosaic Building'] },
  { code: 'PCYNH', name: 'Pepper Canyon Hall', aliases: ['Pepper Canyon Hall', 'PCYNH'] },
  { code: 'PETER', name: 'Peterson Hall', aliases: ['Peterson Hall', 'PETER'] },
  { code: 'PODEM', name: 'Podemos', aliases: ['PODEM', 'Podemos Building'] },
  { code: 'PRICE', name: 'Student Center', aliases: ['Student Center', 'PRICE'] },
  { code: 'RBC', name: 'Robinson Building 2 - Auditorium', aliases: ['Robinson Building 2', 'Robinson Building 2 - Auditorium', 'RBC'] },
  { code: 'RWAC', name: 'Ridge Walk Academic Building', aliases: ['Ridge Walk Academic Building', 'RWAC'] },
  { code: 'SOLIS', name: 'Solis Hall', aliases: ['Solis Hall', 'SOLIS'] },
  { code: 'SSB', name: 'Social Sciences Building', aliases: ['Social Sciences Building', 'SSB'] },
  { code: 'WLH', name: 'Lecture Hall West', aliases: ['Lecture Hall West', 'WLH'] },
  { code: 'YORK', name: 'York Hall', aliases: ['York Hall', 'YORK'] },
  { code: 'DIB', name: 'Design and Innovation Building', aliases: ['Design and Innovation Building', 'DIB'] },
  { code: 'JEANN', name: 'The Jeannie', aliases: ['The Jeannie', 'JEANN'] },
  { code: 'GEISEL', name: 'Main Library', aliases: ['Main Library', 'GEISEL'] },
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
