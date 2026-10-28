// Recorded model responses and a fake ChatClient.
//
// Not a test file. Automated tests exercise the LLM
// path against recorded responses, not a live API." Three reasons, and the third
// is the one people forget:
//   1. the suite stays free and fast
//   2. the suite stays deterministic — a flaky model is a flaky test suite
//   3. the suite stays runnable with NO credentials, which is what keeps
//      keeps a clean clone runnable after the LLM parser exists
// The live call happens in exactly one place: `npm run eval:llm`.
//
// Every string below is a real shape a model produces. The prose wrapper and the
// code fence are not hypothetical edge cases — they are the common case, which is
// why report_parser.md step 2 exists as a step rather than a caveat.

import type { ChatClient, ChatMessage } from '../src/parser/chatClient';

/** A conforming response, no wrapper. */
export const CLEAN_JSON = JSON.stringify({
  service: 'wifi',
  scope: 'location',
  location: 'North Residence Hall',
  building: 'NORTH RESIDENCE HALL',
  room: '',
  symptom: 'intermittent',
  observedAt: '',
});

/** Recorded conforming response for the classroom projector corpus row. */
export const PROJECTOR_JSON = JSON.stringify({
  service: 'classroom_av',
  scope: 'location',
  location: 'Lecture Hall',
  building: 'LECT',
  room: '',
  symptom: 'equipment_unavailable',
  observedAt: '',
});

/** The common case: the model explains itself first. */
export const PROSE_WRAPPED = `Sure! Here's the extracted information:

${CLEAN_JSON}

Let me know if you'd like me to adjust anything.`;

/** The other common case: a markdown code fence. */
export const FENCED = `\`\`\`json
${JSON.stringify(
  { service: 'wifi', scope: 'location', location: 'North Residence Hall', building: 'NORTH RESIDENCE HALL', room: '', symptom: 'intermittent', observedAt: '' },
  null,
  2,
)}
\`\`\``;

/** Valid JSON, invalid against the schema: 'WiFi' is not a catalog value. */
export const OUT_OF_VOCABULARY = JSON.stringify({
  service: 'WiFi',
  scope: 'location',
  location: 'North Residence Hall',
  building: 'NORTH RESIDENCE HALL',
  room: '',
  symptom: 'intermittent',
  observedAt: '',
});

/** Valid JSON, missing a required field. */
export const MISSING_FIELD = JSON.stringify({
  service: 'wifi',
  scope: 'location',
  location: 'North Residence Hall',
  building: 'NORTH RESIDENCE HALL',
  room: '',
  observedAt: '',
});

/** Not JSON at all — the model answered the question instead of extracting. */
export const NO_JSON = 'It sounds like the wifi in North Residence Hall is unstable. Try reconnecting.';

/** Truncated mid-object, as a token limit produces. */
export const TRUNCATED = '{"service": "wifi", "scope": "loc';

/**
 * The model volunteers a field it was never asked for, and paraphrases the
 * reporter while doing it. If this string reaches a ticket body, the service has
 * put model-authored prose in front of an IT agent as though the reporter wrote
 * it. The parser permits exactly one repair attempt.
 */
export const MODEL_SUPPLIED_VERBATIM_TEXT = 'User reports intermittent wireless connectivity in North Residence Hall.';
export const MODEL_SUPPLIED_VERBATIM = JSON.stringify({
  service: 'wifi',
  scope: 'location',
  location: 'North Residence Hall',
  building: 'NORTH RESIDENCE HALL',
  room: '',
  symptom: 'intermittent',
  observedAt: '',
  verbatim: MODEL_SUPPLIED_VERBATIM_TEXT,
});

/** An observedAt in the future — a hallucination, not a prediction. */
export function futureObservedAt(now: Date): string {
  return JSON.stringify({
    service: 'wifi',
    scope: 'location',
    location: 'North Residence Hall',
    building: 'NORTH RESIDENCE HALL',
    room: '',
    symptom: 'intermittent',
    observedAt: new Date(now.getTime() + 86_400_000).toISOString(),
  });
}

export type FakeChatClient = ChatClient & {
  /** Every prompt the parser sent, in order. The repair bound is asserted on this. */
  readonly calls: ChatMessage[][];
};

/**
 * Replays `responses` in order, one per call. A `null` entry throws instead —
 * that is how a timeout or a 500 is induced (error_rescue_map.md
 * `llm_unavailable`). Running past the end throws too, which is deliberate: a
 * test that expects two calls and gets three fails loudly rather than replaying
 * the last response forever and quietly passing the repair-bound assertion.
 */
export function fakeClient(...responses: readonly (string | null)[]): FakeChatClient {
  const calls: ChatMessage[][] = [];
  return {
    calls,
    async complete(messages) {
      const i = calls.length;
      calls.push([...messages]);
      const response = responses[i];
      if (response === undefined) throw new Error(`fake client: unexpected call #${i + 1}`);
      if (response === null) throw new Error('fake client: induced API failure');
      return response;
    },
  };
}
