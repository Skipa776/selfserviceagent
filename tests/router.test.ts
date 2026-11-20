// The stage-2 router: specialist first, the next parser otherwise.

import { describe, expect, it } from 'vitest';

import { buildStage1, buildStage2 } from '../src/composition';
import type { Parser } from '../src/orchestrator';
import { handleReport } from '../src/orchestrator';
import { createRouter } from '../src/parser/router';
import { loadSpecialist, type Specialist, type SpecialistGuess } from '../src/parser/specialist';
import { validateAgainstSchema } from '../src/parser/fieldRules';
import { CORPUS_NOW } from './corpus';

const AUDIT = { confidence: { service: 0.99, scope: 0.99, symptom: 0.99 }, tau: 0.6, datasetSha256: 'test' };
const guessing = (guess: Partial<SpecialistGuess>): Specialist => ({
  predict: () => ({ service: 'wifi', scope: 'location', symptom: 'intermittent', confident: true, audit: AUDIT, ...guess }),
});
const next: Parser = { parse: async (text) => ({ report: { ...(await import('../src/parser/reportParser')).parseReport(text) }, source: 'keyword' }) };
const TEXT = 'wifi in North Residence Hall keeps dropping';

describe('createRouter', () => {
  it('uses a confident specialist answer, with places from the deterministic lookup', async () => {
    const result = await createRouter(guessing({}), next).parse(TEXT);
    expect(result.source).toBe('specialist');
    expect(result.report).toMatchObject({ service: 'wifi', scope: 'location', location: 'North Residence Hall', building: 'NORTH RESIDENCE HALL', symptom: 'intermittent', verbatim: TEXT });
    expect(result.specialist).toEqual(AUDIT);
  });

  it('falls through when the specialist is not confident', async () => {
    expect((await createRouter(guessing({ confident: false }), next).parse(TEXT)).source).toBe('keyword');
  });

  it('falls through when the answer breaks the field rules (a location scope with no place named)', async () => {
    const result = await createRouter(guessing({ scope: 'location' }), next).parse('the wifi keeps dropping');
    expect(result.source).toBe('keyword');
  });

  it('falls through when the specialist throws, and never fails the request', async () => {
    const throwing: Specialist = { predict: () => { throw new Error('boom'); } };
    expect((await createRouter(throwing, next).parse(TEXT)).source).toBe('keyword');
  });

  it('passes the frustration answer along whichever parser answers', async () => {
    const result = await createRouter(guessing({ confident: false, frustrated: true }), next).parse(TEXT);
    expect(result).toMatchObject({ source: 'keyword', frustrated: true });
  });

  it('with no specialist is exactly the next parser', async () => {
    expect(await createRouter(null, next).parse(TEXT)).toEqual(await next.parse(TEXT));
  });
});

describe('the committed specialist', () => {
  const specialist = loadSpecialist();

  it("never accepts an 'unknown' on any report head", () => {
    for (const text of ['my headphones stopped working', 'the internet is weird', '', 'hello']) {
      const guess = specialist.predict(text);
      if ([guess.service, guess.scope, guess.symptom].includes('unknown')) expect(guess.confident).toBe(false);
    }
  });

  // Keyword-stuffed reports (council M2-Q11): recorded, not claimed as defended.
  // Whatever the model makes of them, an accepted answer must still pass the field rules.
  it.each([
    'everyone everywhere campus-wide outage nobody can connect my laptop only',
    'only me only me only me but the whole campus wifi is down everywhere',
    'again again AGAIN!!! fed up ridiculous still broken the projector',
  ])('a stuffed report still produces a rule-abiding record: %s', async (text) => {
    const result = await createRouter(specialist, next).parse(text);
    const { verbatim, ...fields } = result.report;
    void verbatim;
    expect(validateAgainstSchema(fields)).toBeNull();
  });
});

describe('the cost of a hostile report is bounded', () => {
  // Place masking re-scans once per place mention. Before the text was capped
  // (features.ts modelText), a 16 KB body of building codes took 1.6 s and the
  // web endpoint accepts 64 KB; capped, the worst case measured 47 ms.
  it('answers a 64 KB body of building codes in well under a second', () => {
    const specialist = loadSpecialist();
    const started = performance.now();
    specialist.predict('HAB '.repeat(16_000));
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('stage wiring', () => {
  it('stage 1 never uses a model, even with the weights on disk', async () => {
    const system = buildStage1({ clock: () => new Date(CORPUS_NOW) });
    await handleReport({ text: TEXT, identityRef: 'r1', canFollowUp: true }, system.deps);
    expect(system.audit.lines.find((l) => l.action === 'parsed')?.parseSource).toBe('keyword');
  });

  it('stage 2 routes through the specialist and audits its confidence and data version', async () => {
    const system = buildStage2({ createMessage: null, snow: null, clock: () => new Date(CORPUS_NOW) });
    await handleReport({ text: TEXT, identityRef: 'r1', canFollowUp: true }, system.deps);
    const parsed = system.audit.lines.find((l) => l.action === 'parsed');
    expect(parsed?.parseSource).toBe('specialist');
    expect(parsed?.specialistDataset).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed?.specialistConfidence?.scope).toBeGreaterThan(0);
  });
});
