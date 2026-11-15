// Frustration signal — a deterministic placeholder until Milestone 2's "score"
// specialist model replaces it.
//
// NOT VALIDATED against real people. It feeds exactly one thing: the priority
// policy, where a strict MAJORITY of frustrated reporters can raise a parent
// incident by one level and no more (priorityPolicy.ts). A boolean, not a
// scale, because the policy only ever asks yes or no.

// Phrases that say "this keeps happening" or "I am fed up", matched as whole
// words, any case. Data, not logic: extend the list, not the matcher.
const PHRASES = [
  'again',
  'still',
  'every day',
  'every time',
  'third time',
  'fed up',
  'ridiculous',
  'unacceptable',
  'seriously',
];
const PHRASE_PATTERN = new RegExp(`\\b(${PHRASES.join('|')})\\b`, 'i');

/** True when the report's own words read as frustrated. */
export function isFrustrated(text: string): boolean {
  if (PHRASE_PATTERN.test(text)) return true;
  if (/!{2,}/.test(text)) return true;
  // A shouted word, but not an acronym like VPN or LAN (five letters or more).
  return /\b[A-Z]{5,}\b/.test(text);
}
