// keywordExtractor.ts — the STAGE-1 parser (keyword_extractor.md). Free text in, a
// best-effort ProblemReport out, using nothing but string matching against the
// catalog vocabularies. No model, no API key, no network — that is what lets the
// manager demo run on a clone with zero setup.
//
// TWO jobs, and the second outlives the first (keyword_extractor.md):
//   1. Make stage 1 possible (no credential anywhere in the request path).
//   2. Be the PERMANENT control. When the LLM arrives at stage 2 this module stays
//      as the baseline the LLM is measured against, and as the degraded-mode
//      fallback when the LLM API is down. Do not delete it at stage 2.
//
// It is SUPPOSED to be visibly imperfect. It will return 'unknown' on genuinely
// ambiguous reports, and that is correct: a gap gets a follow-up question, a
// confident wrong label gets a wrong ticket. Every heuristic added here is one that
// must be maintained after it has been superseded, and it blunts the stage-2
// comparison. Resist making it smart (keyword_extractor.md, "It is supposed to be
// visibly imperfect").

import type { ProblemReport } from '../contracts/types';
import type { ReportScope, Service, Symptom } from '../vocab/catalog';
import { extractRoom, matchArea, matchBuilding } from '../vocab/locations';

// ── Matching primitive ────────────────────────────────────────────────────────
// A rule maps a catalog value to the surface phrases that signal it. First rule
// whose patterns appear (case-insensitive substring) wins; nothing matches →
// fallback. That is the entire algorithm: no stemming, no fuzzy distance, no
// scoring. This simplicity is the intentional deterministic baseline.
type Rule<T> = { readonly value: T; readonly patterns: readonly string[] };

function firstMatch<T>(haystack: string, rules: readonly Rule<T>[], fallback: T): T {
  const text = haystack.toLowerCase();
  for (const rule of rules) {
    if (rule.patterns.some((p) => text.includes(p))) return rule.value;
  }
  return fallback;
}

// ── Synonym / phrase tables (map ONTO catalog values, never invent one) ────────
// These tables are the "only permitted local addition" (keyword_extractor.md). They
// are data, not logic — extend them via the change procedure (a synonym + a corpus
// row + a parity re-run), never by adding cleverness to the matcher above.

// NOTE the deliberate GAP: "internet" is intentionally absent. Users say "the
// internet is slow" meaning wifi OR wired, and the dumb parser must NOT pick a side
// — leaving service 'unknown' on that row is the honest miss the corpus expects
// (report_corpus.md, the Main Library row).
const SERVICE_RULES: readonly Rule<Service>[] = [
  { value: 'classroom_av', patterns: ['projector', 'classroom display'] },
  { value: 'wifi', patterns: ['wifi', 'wi-fi', 'wireless', 'eduroam'] },
  { value: 'vpn', patterns: ['vpn'] },
  { value: 'web_portal', patterns: ['portal', 'website', 'web site', 'site'] },
  { value: 'wired_network', patterns: ['ethernet', 'wired', 'network jack', 'lan'] },
];

const SYMPTOM_RULES: readonly Rule<Symptom>[] = [
  // Order matters where phrases overlap: "won't connect" (no_connection) must be
  // tested independently of "won't load" (page_error) — they share "won't".
  { value: 'auth_failure', patterns: ['sign in over and over', 'keeps asking me to sign in', 'asks me to log in', 'authentication', 'password'] },
  { value: 'equipment_unavailable', patterns: ['will not turn on', "won't turn on", 'wont turn on', 'no image', 'blank screen'] },
  { value: 'page_error', patterns: ["won't load", 'wont load', "can't load", 'page error', 'error loading'] },
  { value: 'no_connection', patterns: ["can't connect", "won't connect", "can't get on", 'no connection', 'no internet', 'nobody can get on', 'cannot connect'] },
  { value: 'intermittent', patterns: ['keeps dropping', 'keeps disconnecting', 'disconnects', 'drops', 'cuts out', 'on and off'] },
  { value: 'slow', patterns: ['slow', 'sluggish', 'laggy', 'crawling'] },
];

// Location: this module only has to RECOGNIZE a building (keyword_extractor.md).
// Canonical normalization ("North Residence Hall" / "North Residence Hall" → one value) lives in the
// adapter, not here — so there is no catalog location list to match against, only
// this small recognition table. Emits the label-cased token; '' when none found.
// Breadth words that assert a problem spans the whole service (→ service_wide).
const BREADTH_WORDS: readonly string[] = [
  'everywhere',
  'all of campus',
  'across campus',
  'anywhere on campus',
  'campus-wide',
  'campuswide',
  'nobody can',
  'no one can',
  'everyone',
];

// ── Per-field extraction ───────────────────────────────────────────────────────

function matchService(text: string): Service {
  return firstMatch(text, SERVICE_RULES, 'unknown');
}

function matchSymptom(text: string): Symptom {
  return firstMatch(text, SYMPTOM_RULES, 'unknown');
}

function matchLocation(text: string): string {
  const building = matchBuilding(text);
  if (building) return building.building.name === 'Main Library' ? 'Main Library' : building.building.name;
  return matchArea(text);
}

// Scope alone decides INC vs REQ, so this baseline recognizes only explicit
// breadth or a known location and otherwise returns unknown. It intentionally
// does not interpret personal contrasts; that limitation is covered by tests.
function matchScope(text: string, locationMatched: boolean): ReportScope {
  const normalizedText = text.toLowerCase();

  if (BREADTH_WORDS.some((word) => normalizedText.includes(word))) {
    return 'service_wide';
  }

  if (locationMatched) {
    return 'location';
  }

  return 'unknown'
}

// observedAt: the contract captures ONLY explicit absolute/simple-relative times
// ("since 2pm", "this morning") and never infers from tense. No corpus row exercises
// it and the stage-2 LLM handles time far better, so stage 1 captures nothing.
// Return '' until the baseline has explicit, tested time patterns.
function matchObservedAt(text: string): string {
  void text;
  return '';
}

/**
 * Free text → best-effort ProblemReport. Never throws; every field is a catalog
 * value or the honest fallback ('unknown' / ''). `verbatim` is the raw input —
 * length-capping and control-char stripping are the parser's normalization step
 * (reportParser.ts, Step 7), so they live in exactly one place.
 */
export function extract(text: string): ProblemReport {
  const location = matchLocation(text);
  const building = matchBuilding(text);
  return {
    service: matchService(text),
    scope: matchScope(text, location !== ''),
    location,
    building: building?.building.code ?? '',
    room: extractRoom(text, building?.end ?? 0),
    symptom: matchSymptom(text),
    observedAt: matchObservedAt(text),
    verbatim: text,
  };
}
