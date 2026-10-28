// Deterministic baseline parser tests (keyword_extractor.md).
//
// Inputs come from the corpus registry (report_corpus.md); we never paraphrase a
// report inline. But the EXPECTED values here are the *extractor's* honest output,
// which on purpose is NOT the same as the corpus labels: the labels describe what a
// good parser produces, and the dumb keyword parser is expected to miss some of them
// (keyword_extractor.md, "supposed to be visibly imperfect"). Those misses are
// locked in so a silent improvement/regression is visible.
//
// No accuracy target is pinned (report_corpus.md) — this file asserts specific,
// defensible per-row behavior, not a score.

import { describe, it, expect } from 'vitest';
import { extract } from '../src/parser/keywordExtractor';
import { EVAL_ROWS } from './corpus';
import { SERVICES, SCOPES, SYMPTOMS } from '../src/vocab/catalog';

// Row order matches report_corpus.md's eval table.
const R = {
  MUIR_WIFI: 0,
  PORTAL: 1,
  EDUROAM: 2,
  ROOMMATE: 3, // scope 'individual' — keyword parser EXPECTED TO MISS
  GEISEL: 4, // service ambiguous — keyword parser EXPECTED TO MISS
  VPN: 5, // scope 'individual' — no explicit contrast, so a miss too
  PRINTER: 6,
  DEADLINE: 7,
  PROJECTOR: 8,
} as const;

const input = (i: number): string => EVAL_ROWS[i].input;

// ── Invariants ─────────────────────────────────────────────────────────────────
describe('extractor invariants (all rows)', () => {
  for (let i = 0; i < EVAL_ROWS.length; i++) {
    it(`row ${i} → a valid, in-vocabulary ProblemReport that never throws`, () => {
      const r = extract(input(i));
      expect((SERVICES as readonly string[]).includes(r.service)).toBe(true);
      expect((SCOPES as readonly string[]).includes(r.scope)).toBe(true);
      expect((SYMPTOMS as readonly string[]).includes(r.symptom)).toBe(true);
      expect(typeof r.location).toBe('string');
      expect(typeof r.observedAt).toBe('string');
      expect(r.verbatim).toBe(input(i)); // raw passthrough; capping is the parser's job
    });
  }

  it('is deterministic — same input, same record', () => {
    for (let i = 0; i < EVAL_ROWS.length; i++) {
      expect(extract(input(i))).toEqual(extract(input(i)));
    }
  });
});

// ── Service, symptom, and location ─────────────────────────────────────────────
describe('service matching', () => {
  it('recognizes clear services', () => {
    expect(extract(input(R.MUIR_WIFI)).service).toBe('wifi');
    expect(extract(input(R.PORTAL)).service).toBe('web_portal');
    expect(extract(input(R.EDUROAM)).service).toBe('wifi');
    expect(extract(input(R.VPN)).service).toBe('vpn');
    expect(extract(input(R.PROJECTOR)).service).toBe('classroom_av');
  });

  it('declines out-of-domain reports → unknown', () => {
    expect(extract(input(R.PRINTER)).service).toBe('unknown');
    expect(extract(input(R.DEADLINE)).service).toBe('unknown');
  });

  it('does NOT disambiguate "internet" → stays unknown (instructive miss)', () => {
    // report_corpus.md: users do not distinguish wifi from wired. Picking a side
    // here would be a coin flip and would blunt the stage-2 comparison.
    expect(extract(input(R.GEISEL)).service).toBe('unknown');
  });
});

describe('symptom matching', () => {
  it('recognizes clear symptoms', () => {
    expect(extract(input(R.MUIR_WIFI)).symptom).toBe('intermittent');
    expect(extract(input(R.PORTAL)).symptom).toBe('page_error');
    expect(extract(input(R.EDUROAM)).symptom).toBe('no_connection');
    expect(extract(input(R.GEISEL)).symptom).toBe('slow');
    expect(extract(input(R.VPN)).symptom).toBe('auth_failure');
    expect(extract(input(R.PROJECTOR)).symptom).toBe('equipment_unavailable');
  });
});

describe('location recognition', () => {
  it('recognizes known buildings, blank otherwise', () => {
    expect(extract(input(R.MUIR_WIFI)).location).toBe('North Residence Hall');
    expect(extract(input(R.GEISEL)).location).toBe('Main Library');
    expect(extract(input(R.EDUROAM)).location).toBe(''); // "campus" is not a building
    expect(extract(input(R.PRINTER)).location).toBe('');
    expect(extract(input(R.PROJECTOR)).location).toBe('Lecture Hall');
  });

  it('keeps Lecture Hall as the ordinary canonical location', () => {
    const text = 'The projector in Lecture Hall will not turn on';
    expect(extract(text)).toMatchObject({
      location: 'Lecture Hall',
      scope: 'location',
    });
  });
});

// ── Scope matching ─────────────────────────────────────────────────────────────
describe('scope matching', () => {
  it('breadth words → service_wide', () => {
    expect(extract(input(R.EDUROAM)).scope).toBe('service_wide'); // "anywhere on campus"
  });

  it('a matched location → location', () => {
    expect(extract(input(R.MUIR_WIFI)).scope).toBe('location');
    expect(extract(input(R.GEISEL)).scope).toBe('location');
    expect(extract(input(R.PROJECTOR)).scope).toBe('location');
  });

  it('no signal → unknown (bias to unknown, never guess a class)', () => {
    expect(extract(input(R.PORTAL)).scope).toBe('unknown');
    expect(extract(input(R.PRINTER)).scope).toBe('unknown');
    expect(extract(input(R.DEADLINE)).scope).toBe('unknown');
  });
});

// ── The instructive misses: they must STAY missed (regression guards) ──────────
// If either of these ever flips to 'individual', the module has been made too smart
// and the stage-2 argument has been blunted (keyword_extractor.md).
describe('scope stays deliberately dumb', () => {
  it('does NOT infer individual from the roommate contrast', () => {
    expect(extract(input(R.ROOMMATE)).scope).toBe('unknown'); // label is 'individual' — expected miss
  });

  it('does NOT infer individual from "me" in the VPN report', () => {
    expect(extract(input(R.VPN)).scope).toBe('unknown'); // label is 'individual' — expected miss
  });
});
