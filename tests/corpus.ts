// The labeled report corpus (report_corpus.md) — the ONE registry the parsing
// eval and every flow test draw from. Tests import these rows; they never
// paraphrase a report inline (a reworded example is a registry edit).
//
// Everything here is SYNTHETIC. No real report, name, student ID, email, or ticket text
// (safety/boundaries.md). tests/piiScan.test.ts mechanically enforces that.
//
// Two distinct uses, deliberately not mixed (report_corpus.md "Responsibility"):
//   • EVAL_ROWS  — inputs are user PHRASINGS, labels are expected ProblemReport
//                  fields. Measures a parser.
//   • FLOWS      — inputs are RECORDS + a fixture world, labels are expected
//                  outcomes. Measures the deterministic core.

import type {
  ProblemReport,
  MatchCandidate,
  DeclaredIncident,
  PeerTicket,
  ApiOutcome,
} from '../src/contracts/types';
import type { Service, ReportScope, TicketScope, Symptom } from '../src/vocab/catalog';

// ── Parsing eval set (report_corpus.md) ───────────────────────────────────────

export type EvalRow = {
  readonly id: string;
  readonly groupId: string;
  readonly role: 'student' | 'faculty' | 'staff';
  readonly input: string;
  /** The expected service — or, for a genuinely ambiguous report, any of these. */
  readonly service: Service | readonly Service[];
  readonly scope: ReportScope;
  readonly location: string;
  readonly building: string;
  readonly room: string;
  readonly symptom: Symptom;
  readonly note?: string;
};

export const EVAL_ROWS: readonly EvalRow[] = [
  {
    id: 'wifi-north-residence-hall-01', groupId: 'wifi-location-north-residence-hall', role: 'student',
    input: 'wifi in North Residence Hall keeps dropping',
    service: 'wifi',
    scope: 'location',
    location: 'North Residence Hall',
    building: 'NORTH RESIDENCE HALL', room: '',
    symptom: 'intermittent',
  },
  {
    id: 'portal-housing-ambiguous-01', groupId: 'portal-housing-scope-unknown', role: 'student',
    input: "the housing portal won't load",
    service: 'web_portal',
    scope: 'unknown',
    location: '',
    building: '', room: '',
    symptom: 'page_error',
    note: 'scope genuinely uninferable — one browser vs a campus outage read identical; correct is unknown → NEEDS_DETAIL. A parser that confidently labels this is wrong in a way that costs a ticket class.',
  },
  {
    id: 'wifi-eduroam-campus-01', groupId: 'wifi-service-wide', role: 'faculty',
    input: "I can't get on eduroam anywhere on campus today",
    service: 'wifi',
    scope: 'service_wide',
    location: '',
    building: '', room: '',
    symptom: 'no_connection',
  },
  {
    id: 'wifi-dorm-personal-01', groupId: 'wifi-individual-dorm', role: 'student',
    input: "my laptop won't connect to the wifi in my dorm but my roommate's does",
    service: 'wifi',
    scope: 'individual',
    location: '',
    building: '', room: '',
    symptom: 'no_connection',
    note: 'the contrast is the only signal for individual — the clearest row where the LLM should beat the keyword parser. The keyword parser is expected to miss it.',
  },
  {
    id: 'internet-main-library-ambiguous-01', groupId: 'internet-main-library-service-unknown', role: 'student',
    input: 'the internet in Main Library is super slow this afternoon',
    service: 'unknown',
    scope: 'location',
    location: 'Main Library',
    building: 'LIB', room: '',
    symptom: 'slow',
    note: 'service ambiguous by design — users do not distinguish wifi from wired. Do not "fix" this row by picking a side; resolving it is a follow-up.',
  },
  {
    id: 'vpn-auth-01', groupId: 'vpn-individual-auth', role: 'staff',
    input: 'VPN keeps asking me to sign in over and over',
    service: 'vpn',
    scope: 'individual',
    location: '',
    building: '', room: '',
    symptom: 'auth_failure',
  },
  {
    id: 'unknown-printer-01', groupId: 'out-of-domain-printer', role: 'staff',
    input: 'my printer is out of toner',
    service: 'unknown',
    scope: 'unknown',
    location: '',
    building: '', room: '',
    symptom: 'unknown',
    note: 'out-of-domain → decline cleanly rather than file something unclassifiable.',
  },
  {
    id: 'unknown-deadline-01', groupId: 'out-of-domain-question', role: 'student',
    input: 'when is the housing application deadline',
    service: 'unknown',
    scope: 'unknown',
    location: '',
    building: '', room: '',
    symptom: 'unknown',
    note: 'not a problem report at all → unknown.',
  },
  {
    id: 'av-center-roomless-01', groupId: 'av-center-building-level', role: 'faculty',
    input: 'The projector in Lecture Hall will not turn on',
    service: 'classroom_av',
    scope: 'location',
    location: 'Lecture Hall',
    building: 'LECT', room: '',
    symptom: 'equipment_unavailable',
  },
  {
    id: 'wifi-north-residence-hall-02', groupId: 'wifi-location-north-residence-hall', role: 'faculty',
    input: 'North Residence Hall wireless keeps cutting out for my class',
    service: 'wifi', scope: 'location', location: 'North Residence Hall', building: 'NORTH RESIDENCE HALL', room: '', symptom: 'intermittent',
  },
  {
    id: 'wifi-north-residence-hall-03', groupId: 'wifi-location-north-residence-hall', role: 'staff',
    input: 'Our Wi-Fi connection in North Residence Hall is on and off again',
    service: 'wifi', scope: 'location', location: 'North Residence Hall', building: 'NORTH RESIDENCE HALL', room: '', symptom: 'intermittent',
  },
  {
    id: 'wired-hab-01', groupId: 'wired-hab-location', role: 'student',
    input: 'the ethernet at HAB room 201 is crawling',
    service: 'wired_network', scope: 'location', location: 'Hillside Academic Building', building: 'HAB', room: '201', symptom: 'slow',
  },
  {
    id: 'wired-hab-02', groupId: 'wired-hab-location', role: 'faculty',
    input: 'Wired network in the Hillside Academic Building is very sluggish',
    service: 'wired_network', scope: 'location', location: 'Hillside Academic Building', building: 'HAB', room: '', symptom: 'slow',
  },
  {
    id: 'wired-hab-03', groupId: 'wired-hab-location', role: 'staff',
    input: 'I am seeing a slow LAN connection in HAB',
    service: 'wired_network', scope: 'location', location: 'Hillside Academic Building', building: 'HAB', room: '', symptom: 'slow',
  },
  {
    id: 'wired-price-01', groupId: 'wired-price-location', role: 'student',
    input: 'the network jack in Student Center will not connect',
    service: 'wired_network', scope: 'location', location: 'Student Center', building: 'STUC', room: '', symptom: 'no_connection',
  },
  {
    id: 'vpn-personal-01', groupId: 'vpn-individual-auth', role: 'student',
    input: 'My campus VPN login loops whenever I try to connect',
    service: 'vpn', scope: 'individual', location: '', building: '', room: '', symptom: 'auth_failure',
  },
  {
    id: 'vpn-campus-01', groupId: 'vpn-service-wide', role: 'staff',
    input: 'Nobody can connect to the campus VPN right now',
    service: 'vpn', scope: 'service_wide', location: '', building: '', room: '', symptom: 'no_connection',
  },
  {
    id: 'portal-canvas-01', groupId: 'portal-canvas-wide', role: 'faculty',
    input: 'Canvas is returning an error for everyone in my course',
    service: 'web_portal', scope: 'service_wide', location: '', building: '', room: '', symptom: 'page_error',
  },
  {
    id: 'portal-student-personal-01', groupId: 'portal-individual-auth', role: 'student',
    input: 'I am the only one who cannot sign in to the housing website',
    service: 'web_portal', scope: 'individual', location: '', building: '', room: '', symptom: 'auth_failure',
  },
  {
    id: 'portal-generic-ambiguous-02', groupId: 'portal-generic-scope-unknown', role: 'staff',
    input: 'The registration site is showing an error',
    service: 'web_portal', scope: 'unknown', location: '', building: '', room: '', symptom: 'page_error',
    note: 'Generic portal symptom does not establish whether one person or the campus is affected.',
  },
  {
    id: 'portal-main-library-ambiguous-02', groupId: 'internet-main-library-service-unknown', role: 'faculty',
    input: 'Internet access around Main Library is painfully slow',
    service: 'unknown', scope: 'location', location: 'Main Library', building: 'LIB', room: '', symptom: 'slow',
    note: 'Generic internet must not be guessed as wifi or wired.',
  },
  {
    id: 'av-center-room-01', groupId: 'av-center-room-214', role: 'student',
    input: 'The display in room 214, Lecture Hall is blank',
    service: 'classroom_av', scope: 'location', location: 'Lecture Hall', building: 'LECT', room: '214', symptom: 'equipment_unavailable',
  },
  {
    id: 'av-center-room-02', groupId: 'av-center-room-214', role: 'faculty',
    input: 'Lecture Hall 214 projector will not power on',
    service: 'classroom_av', scope: 'location', location: 'Lecture Hall', building: 'LECT', room: '214', symptom: 'equipment_unavailable',
  },
  {
    id: 'av-center-room-03', groupId: 'av-center-room-214', role: 'staff',
    input: 'In LECT room 214, the classroom display has no image',
    service: 'classroom_av', scope: 'location', location: 'Lecture Hall', building: 'LECT', room: '214', symptom: 'equipment_unavailable',
  },
  {
    id: 'av-center-building-02', groupId: 'av-center-building-level', role: 'student',
    input: 'Projectors across Lecture Hall are not turning on',
    service: 'classroom_av', scope: 'location', location: 'Lecture Hall', building: 'LECT', room: '', symptom: 'equipment_unavailable',
  },
  {
    id: 'av-center-building-03', groupId: 'av-center-building-level', role: 'staff',
    input: 'Faculty reports that the AV equipment in Lecture Hall is unavailable',
    service: 'classroom_av', scope: 'location', location: 'Lecture Hall', building: 'LECT', room: '', symptom: 'equipment_unavailable',
  },
];

// ── Flow scenarios (report_corpus.md) ─────────────────────────────────────────
// Time is expressed relative to a FIXED instant so tests are deterministic (no
// wall clock). A flow test injects `clock = () => CORPUS_NOW` and a match window;
// IN_WINDOW / OUT_OF_WINDOW are chosen so any sane injected window separates them.
export const CORPUS_NOW = '2026-07-28T12:00:00.000Z';
const minsAgo = (m: number): string =>
  new Date(Date.parse(CORPUS_NOW) - m * 60_000).toISOString();
const IN_WINDOW = minsAgo(15); // clearly recent
const OUT_OF_WINDOW = minsAgo(60 * 48); // ~2 days old — outside any reasonable window

// Scores are chosen far from the middle so any injected MATCH_SCORE_THRESHOLD in
// (0.1, 0.95) classifies them the same way. The threshold itself is UNSET and
// injected by the test — never defaulted here.
const MATCH = 0.95;

function peer(o: {
  id: string;
  reporterHash: string;
  service?: Service;
  scope?: TicketScope;
  locations?: readonly string[];
  symptom?: Symptom;
   building?: string;
   room?: string;
  openedAt?: string;
  matchScore?: number;
}): PeerTicket {
  return {
    kind: 'peer_ticket',
    id: o.id,
    service: o.service ?? 'wifi',
    scope: o.scope ?? 'location',
    locations: o.locations ?? ['North Residence Hall'],
    symptom: o.symptom ?? 'intermittent',
    building: o.building ?? ((o.locations ?? ['North Residence Hall'])[0] === 'North Residence Hall' ? 'NORTH RESIDENCE HALL' : (o.locations ?? ['North Residence Hall'])[0] === 'South Residence Hall' ? 'SOUTH RESIDENCE HALL' : ''),
    room: o.room ?? '',
    openedAt: o.openedAt ?? IN_WINDOW,
    matchScore: o.matchScore ?? MATCH,
    reporterHash: o.reporterHash,
    url: `https://it.example.edu/ticket/${o.id}`,
  };
}

function declared(o: {
  id: string;
  summary: string;
  status?: string;
  service?: Service;
  scope?: TicketScope;
  locations?: readonly string[];
  symptom?: Symptom;
  building?: string;
  room?: string;
  openedAt?: string;
  statusUpdatedAt?: string;
  matchScore?: number;
}): DeclaredIncident {
  const opened = o.openedAt ?? IN_WINDOW;
  return {
    kind: 'declared_incident',
    id: o.id,
    service: o.service ?? 'wifi',
    scope: o.scope ?? 'location',
    locations: o.locations ?? ['North Residence Hall'],
    symptom: o.symptom ?? 'intermittent',
    building: o.building ?? ((o.locations ?? ['North Residence Hall'])[0] === 'North Residence Hall' ? 'NORTH RESIDENCE HALL' : (o.locations ?? ['North Residence Hall'])[0] === 'South Residence Hall' ? 'SOUTH RESIDENCE HALL' : ''),
    room: o.room ?? '',
    openedAt: opened,
    matchScore: o.matchScore ?? MATCH,
    reporterHash: '', // declared incidents carry no reporter (match_candidate.md)
    url: `https://status.example.edu/incident/${o.id}`,
    status: o.status ?? 'investigating',
    statusUpdatedAt: o.statusUpdatedAt ?? opened,
    summary: o.summary,
  };
}

const report = (p: Partial<ProblemReport> & { verbatim: string }): ProblemReport => ({
  service: 'wifi',
  scope: 'location',
  location: 'North Residence Hall',
  symptom: 'intermittent',
  observedAt: '',
  building: 'NORTH RESIDENCE HALL',
  room: '',
  ...p,
});

/** The canonical North Residence Hall wifi report reused by the count-boundary and window flows. */
const NORTH_HALL_WIFI = report({ verbatim: 'the wifi in North Residence Hall keeps dropping' });

// Distinct-reporter peer sets — the heart of the count rule (F2/F3/F4).
// The threshold is an EXISTING-peer ceiling: if search finds 5 matching wifi
// tickets already open, the NEXT report is deflected instead of creating a 6th.
// So the deflect fixture carries FIVE existing peers, and FOUR_DISTINCT is the
// last count that still files the next report.
const FIVE_DISTINCT: readonly PeerTicket[] = ['a', 'b', 'c', 'd', 'e'].map((r, i) =>
  peer({ id: `REQ30${i}`, reporterHash: `rh_${r}` }),
);
const FOUR_DISTINCT: readonly PeerTicket[] = FIVE_DISTINCT.slice(0, 4);
const FIVE_FROM_ONE: readonly PeerTicket[] = [0, 1, 2, 3, 4].map((i) =>
  peer({ id: `REQ31${i}`, reporterHash: 'rh_a' }),
);

// Canvas / web_portal has a per-topic threshold of 10 (clusterGate TOPIC_THRESHOLDS):
// if 10 matching tickets already exist, the 11th report is suppressed. These sets
// exercise that the deflection point moves with the topic, not just the count.
const CANVAS = report({
  service: 'web_portal',
  scope: 'service_wide',
  location: '',
  symptom: 'page_error',
  verbatim: 'canvas is throwing errors for my whole class',
});
const canvasPeer = (i: number, reporterHash: string): PeerTicket =>
  peer({ id: `REQ40${i}`, reporterHash, service: 'web_portal', scope: 'service_wide', locations: [] });
const TEN_DISTINCT_CANVAS: readonly PeerTicket[] = Array.from({ length: 10 }, (_, i) =>
  canvasPeer(i, `rh_c${i}`),
);

const PROJECTOR = report({
  service: 'classroom_av',
  scope: 'location',
  location: 'Lecture Hall',
  building: 'LECT',
  room: '',
  symptom: 'equipment_unavailable',
  verbatim: EVAL_ROWS[8].input,
});
const THREE_DISTINCT_PROJECTOR: readonly PeerTicket[] = Array.from({ length: 3 }, (_, i) =>
  peer({
    id: `INCPROJECTOR${String(i + 1).padStart(4, '0')}`,
    reporterHash: `rh_projector_${i + 1}`,
    service: 'classroom_av',
    scope: 'location',
    locations: ['Lecture Hall'],
    building: 'LECT',
    room: '',
    symptom: 'equipment_unavailable',
  }),
);

export type FixtureWorld = {
  /** What IncidentSource.search returns (both kinds, per adapters.md). */
  readonly candidates: readonly MatchCandidate[];
  /** Caller can ask a follow-up question and resubmit (api_contract.md). */
  readonly canFollowUp: boolean;
  /** Set when the user rejected a prior match — files regardless of the gate. */
  readonly overrideMatchId?: string;
  /** The reporter is over the throttle limit — checked before search. */
  readonly throttled?: boolean;
  /** IncidentSource.search fails — must yield UNAVAILABLE, never a blind filing. */
  readonly searchFails?: boolean;
};

export type FlowScenario = {
  readonly id: string;
  readonly report: ProblemReport;
  readonly world: FixtureWorld;
  readonly expected: ApiOutcome;
  /** Whether exactly one ticket is created. Makes F13's "no ticket" first-class. */
  readonly filesTicket: boolean;
  readonly note: string;
};

export const FLOWS: readonly FlowScenario[] = [
  {
    id: 'F1',
    report: NORTH_HALL_WIFI,
    world: {
      candidates: [declared({ id: 'INC1001', summary: 'Wi-Fi disruption affecting North Residence Hall' })],
      canFollowUp: true,
    },
    expected: 'MATCHED_DECLARED',
    filesTicket: false,
    note: 'A declared incident covers this in window → deflect at match #1. Count is never consulted.',
  },
  {
    id: 'F2',
    report: NORTH_HALL_WIFI,
    world: { candidates: FIVE_DISTINCT, canFollowUp: true },
    expected: 'MATCHED_CLUSTER',
    filesTicket: false,
    note: '5 peers from distinct reporters already open, in window → the default threshold of 5 is met, so the NEXT matching report is deflected.',
  },
  {
    id: 'F3',
    report: NORTH_HALL_WIFI,
    world: { candidates: FOUR_DISTINCT, canFollowUp: true },
    expected: 'FILED_INCIDENT',
    filesTicket: true,
    note: '4 distinct reporters already open — below the default threshold of 5, so the next report still files. Half the count rule.',
  },
  {
    id: 'F4',
    report: NORTH_HALL_WIFI,
    world: { candidates: FIVE_FROM_ONE, canFollowUp: true },
    expected: 'FILED_INCIDENT',
    filesTicket: true,
    note: '5 tickets but ONE reporter → distinct count is 1, not 5. One person cannot manufacture a cluster.',
  },
  {
    id: 'F5',
    report: NORTH_HALL_WIFI,
    world: {
      candidates: [
        declared({
          id: 'INC1002',
          summary: 'Wi-Fi disruption affecting North Residence Hall',
          openedAt: OUT_OF_WINDOW,
          statusUpdatedAt: OUT_OF_WINDOW,
        }),
      ],
      canFollowUp: true,
    },
    expected: 'FILED_INCIDENT',
    filesTicket: true,
    note: 'Declared incident is stale (outside the window) → it no longer covers; file.',
  },
  {
    id: 'F6',
    report: NORTH_HALL_WIFI,
    world: {
      candidates: [
        declared({
          id: 'INC1003',
          summary: 'Wi-Fi disruption affecting South Residence Hall',
          locations: ['South Residence Hall'],
        }),
      ],
      canFollowUp: true,
    },
    expected: 'FILED_INCIDENT',
    filesTicket: true,
    note: 'Declared incident is for a different location → does not cover North Residence Hall; file. Tests location coverage, not just service.',
  },
  {
    id: 'F7',
    report: report({
      service: 'web_portal',
      scope: 'individual',
      location: '',
      symptom: 'auth_failure',
      verbatim: 'the housing portal keeps signing me out on my laptop',
    }),
    world: { candidates: [], canFollowUp: true },
    expected: 'FILED_REQUEST',
    filesTicket: true,
    note: 'Individual scope, nothing open → REQ (scope alone decides class).',
  },
  {
    id: 'F8',
    report: report({
      service: 'wifi',
      scope: 'service_wide',
      location: '',
      symptom: 'no_connection',
      verbatim: 'nobody can get on the wifi anywhere on campus today',
    }),
    world: { candidates: [], canFollowUp: true },
    expected: 'FILED_INCIDENT',
    filesTicket: true,
    note: 'Service-wide scope, nothing open → INC.',
  },
  {
    id: 'F9',
    report: report({
      service: 'web_portal',
      scope: 'unknown',
      location: '',
      symptom: 'page_error',
      verbatim: "the housing portal won't load",
    }),
    world: { candidates: [], canFollowUp: true },
    expected: 'NEEDS_DETAIL',
    filesTicket: false,
    note: 'Scope unknown and the caller CAN follow up → ask, do not guess. No search, no ticket.',
  },
  {
    id: 'F10',
    report: report({
      service: 'web_portal',
      scope: 'unknown',
      location: '',
      symptom: 'page_error',
      verbatim: "the housing portal won't load",
    }),
    world: { candidates: [], canFollowUp: false },
    expected: 'FILED_REQUEST',
    filesTicket: true,
    note: 'Scope unknown but the caller is one-shot → file as REQ, the safe direction (inflates no incident count).',
  },
  {
    id: 'F11',
    report: NORTH_HALL_WIFI,
    world: { candidates: FIVE_DISTINCT, canFollowUp: true, overrideMatchId: 'REQ300' },
    expected: 'FILED_INCIDENT',
    filesTicket: true,
    note: 'Would deflect (5 distinct already open meets threshold 5), but the user overrode the match → file, and record an `overridden` audit line.',
  },
  {
    id: 'F12',
    report: NORTH_HALL_WIFI,
    world: { candidates: [], canFollowUp: true, throttled: true },
    expected: 'THROTTLED',
    filesTicket: false,
    note: 'Reporter over the limit → throttle BEFORE search. No search, no ticket, no stream event.',
  },
  {
    id: 'F13',
    report: NORTH_HALL_WIFI,
    world: { candidates: [], canFollowUp: true, searchFails: true },
    expected: 'UNAVAILABLE',
    filesTicket: false,
    note: 'Incident search is down → UNAVAILABLE. A failed search NEVER falls through to filing (that would flood IT during the very incident that broke search).',
  },
  {
    id: 'F14',
    report: CANVAS,
    world: { candidates: TEN_DISTINCT_CANVAS, canFollowUp: true },
    expected: 'MATCHED_CLUSTER',
    filesTicket: false,
    note: 'Canvas (web_portal) has a per-topic threshold of 10. Once 10 distinct matching tickets already exist, the NEXT matching report is suppressed.',
  },
  {
    id: 'F15',
    report: CANVAS,
    world: { candidates: TEN_DISTINCT_CANVAS.slice(0, 9), canFollowUp: true },
    expected: 'FILED_INCIDENT',
    filesTicket: true,
    note: 'Canvas below its threshold (9 matching distinct reporters already open) still files the next report. Once 10 exist, the following report is suppressed.',
  },
  {
    id: 'F16',
    report: PROJECTOR,
    world: { candidates: THREE_DISTINCT_PROJECTOR.slice(0, 2), canFollowUp: true },
    expected: 'FILED_INCIDENT',
    filesTicket: true,
    note: 'Classroom AV below its threshold (2 matching projector reporters already open) files the third ticket.',
  },
  {
    id: 'F17',
    report: PROJECTOR,
    world: { candidates: THREE_DISTINCT_PROJECTOR, canFollowUp: true },
    expected: 'MATCHED_CLUSTER',
    filesTicket: false,
    note: 'Classroom AV reaches its service threshold at 3 existing matching projector reporters, so the next report is suppressed.',
  },
];
