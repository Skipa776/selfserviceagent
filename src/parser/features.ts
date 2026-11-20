// Text → feature buckets for the specialist models. The ONE part of Milestone 2
// that must match Python byte for byte (training/train.py, `tokens`, `fnv1a`,
// `buckets`); tests/specialistParity.test.ts checks it on shared fixtures.
//
// Deliberately plain: ASCII-only lowercasing and [a-z0-9]+ tokens, so JavaScript
// (UTF-16 strings) and Python (code points) cannot disagree on non-ASCII text.
//
// Place names are masked BEFORE hashing, here in TypeScript only: the training
// set stores the masked text and Python never sees a building name. Without the
// mask the first model learned "humanities" as evidence of no_connection, a
// sampling accident (council M2 follow-up ruling 1).

import { AREA_TOKENS, matchBuilding } from '../vocab/locations';
import { VERBATIM_MAX_LEN } from './reportParser';

/** Hash space: 2^16 buckets. Must equal the `dimensions` in models/weights.json. */
export const DIMENSIONS = 65_536;
/** Tokens, not characters: tokens are ASCII, so both languages count the same. */
export const MAX_TOKENS = 400;

/** Stands in for any recognized building or area. Not a real word, so it cannot collide with one. */
export const PLACE_TOKEN = 'xplacex';

/** Replaces every place the service's own matchers recognize; rooms are kept. */
export function maskPlaces(text: string): string {
  let masked = text;
  // Each pass removes one building mention, so the loop ends.
  for (let match = matchBuilding(masked); match !== null; match = matchBuilding(masked)) {
    masked = `${masked.slice(0, match.start)} ${PLACE_TOKEN} ${masked.slice(match.end)}`;
  }
  for (const area of AREA_TOKENS) masked = masked.replace(new RegExp(`\\b${area}\\b`, 'gi'), ` ${PLACE_TOKEN} `);
  return masked;
}

/**
 * The text the models see: the first VERBATIM_MAX_LEN characters (the same cap the
 * reporter's own words get), with places masked. Capping first bounds the cost of
 * maskPlaces, which re-scans once per place mention: a 64 KB body stuffed with
 * building codes took seconds before the cap. Used by both inference and the
 * training-set builder, so the two always agree.
 */
export function modelText(text: string): string {
  return maskPlaces(text.slice(0, VERBATIM_MAX_LEN));
}

export function tokens(text: string): string[] {
  const lowered = text.replace(/[A-Z]/g, (c) => c.toLowerCase());
  return (lowered.match(/[a-z0-9]+/g) ?? []).slice(0, MAX_TOKENS);
}

/** 32-bit FNV-1a. Feature strings are ASCII, so their UTF-16 code units are their bytes. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Word 1-grams and 2-grams. A space never appears inside a token, so the two kinds cannot collide as strings. */
export function grams(text: string): string[] {
  const t = tokens(text);
  return [...t, ...t.slice(1).map((token, i) => `${t[i]} ${token}`)];
}

/** Sorted, de-duplicated buckets: binary presence, no counts. */
export function featureBuckets(text: string): number[] {
  return [...new Set(grams(text).map((g) => fnv1a(g) % DIMENSIONS))].sort((a, b) => a - b);
}
