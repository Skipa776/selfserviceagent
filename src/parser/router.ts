// The stage-2 parser: specialist first, then whatever was wired before it
// (Claude Haiku 5.5 with its keyword fallback, or the keyword parser alone).
//
// The specialist's answer is used only when it is confident AND, together with
// the places the deterministic extractor found, it passes the same field rules a
// Haiku answer must pass (fieldRules.ts). Otherwise the report goes to the next
// parser untouched: abstaining never blocks a report. One report, one source; no
// mixing of fields from two models.

import type { Parser, ParseResult } from '../orchestrator';
import { validateAgainstSchema } from './fieldRules';
import { normalize, parseReport } from './reportParser';
import type { Specialist, SpecialistGuess } from './specialist';

export function createRouter(specialist: Specialist | null, next: Parser): Parser {
  return {
    async parse(text: string): Promise<ParseResult> {
      let guess: SpecialistGuess | null;
      try {
        guess = specialist?.predict(text) ?? null;
      } catch {
        guess = null; // a failing specialist abstains, it never fails the request
      }
      // The frustration answer rides along whichever parser answers the fields.
      const extras = guess === null ? {} : { frustrated: guess.frustrated, specialist: guess.audit };

      if (guess?.confident) {
        const places = parseReport(text); // location, building, room: always the deterministic lookup
        const candidate = {
          service: guess.service,
          scope: guess.scope,
          symptom: guess.symptom,
          location: places.location,
          building: places.building,
          room: places.room,
          observedAt: '',
        };
        if (validateAgainstSchema(candidate) === null) {
          return { report: normalize({ ...candidate, verbatim: text }), source: 'specialist', ...extras };
        }
      }
      return { ...(await next.parse(text)), ...extras };
    },
  };
}
