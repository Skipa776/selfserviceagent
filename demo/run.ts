// The stage-1 demo driver — the thin local harness api_contract.md calls for.
//
// Run it with `npm run demo`. No credentials, no network, no configuration: that
// property IS stage 1, so if this ever needs an API key, something has drifted.
//
// The script is deliberately a narrative rather than a menu. It walks the count
// boundary (the first five file, the sixth is deflected),
// then the declared-incident deflect, then the override — which is the whole
// product in three interactions.

import type { DeclaredIncident, PeerTicket } from '../src/contracts/types';
import { buildStage1, DEMO_GATE, DEMO_THROTTLE } from '../src/composition';
import { CLUSTER_THRESHOLD, thresholdFor } from '../src/clusterGate';
import { postReport } from '../src/api';
import { canonicalSeedBuilding } from '../src/demoSeeds';

// Fixed instant so a re-run prints the same thing in front of an audience.
const DEMO_NOW = new Date('2026-07-28T12:00:00.000Z');

const system = buildStage1({ clock: () => DEMO_NOW });
const { deps, incidents, tickets, detector } = system;

const line = (s = ''): void => {
  process.stdout.write(`${s}\n`);
};
const rule = (title: string): void => {
  line();
  line(`${'─'.repeat(78)}`);
  line(`  ${title}`);
  line(`${'─'.repeat(78)}`);
};

type PeerShape = Pick<PeerTicket, 'service' | 'scope' | 'locations' | 'symptom'>;

const WIFI_MUIR: PeerShape = {
  service: 'wifi',
  scope: 'location',
  locations: ['North Residence Hall'],
  symptom: 'intermittent',
};
const CANVAS_WIDE: PeerShape = {
  service: 'web_portal',
  scope: 'service_wide',
  locations: [],
  symptom: 'no_connection',
};
const PROJECTOR_CENTER_HALL: PeerShape = {
  service: 'classroom_av',
  scope: 'location',
  locations: ['Lecture Hall'],
  symptom: 'equipment_unavailable',
};

async function report(
  who: string,
  text: string,
  opts?: { overrideMatchId?: string; peerShape?: PeerShape },
): Promise<string> {
  const { overrideMatchId, peerShape = WIFI_MUIR } = opts ?? {};
  const { status, body } = await postReport(
    { text, identityRef: who, canFollowUp: true, ...(overrideMatchId ? { overrideMatchId } : {}) },
    deps,
  );

  line();
  line(`  ${who} says: "${text}"`);
  line(`  → HTTP ${status}  ${body.outcome}`);
  line(`  → ${body.reply}`);
  if (body.override !== undefined) line(`  → override handle: ${body.override.matchId}`);

  // Fixture-world maintenance, NOT product logic: a ticket this service just
  // filed becomes a peer the next search can see. Stage 2 gets this for free by
  // reading peer tickets back out of the ServiceNow PDI.
  if (body.ticket !== undefined) {
    const { hash } = await deps.identity.resolve(who);
    const peer: PeerTicket = {
      kind: 'peer_ticket',
      id: body.ticket.ticketNumber,
      ...peerShape,
       building: canonicalSeedBuilding(peerShape),
      room: '',
      openedAt: DEMO_NOW.toISOString(),
      matchScore: 0, // recomputed by the adapter on every search
      reporterHash: hash,
      url: body.ticket.url,
    };
    incidents.add(peer);
  }

  for (const alert of system.drainToDetector()) {
    if (alert === null) continue;
    line();
    line(`  ⚑ NOC ADVISORY (${alert.alertId}) — status: ${alert.status}`);
    line(`    ${alert.distinctReporters} distinct reporters, ${alert.service} @ ${alert.location || 'campus-wide'},`);
    line(`    within ${alert.windowMinutes} minutes. Tickets: ${alert.ticketNumbers.join(', ')}`);
    line(`    This service does not declare outages. A human at NOC decides what this means.`);
  }

  return body.override?.matchId ?? '';
}

async function main(): Promise<void> {
  rule('Stage 1 — deterministic demo. No credentials, no network.');
  line(`  CLUSTER_THRESHOLD ......... ${CLUSTER_THRESHOLD}   (default ceiling; labelled placeholder)`);
  line(`  per-topic ceilings ........ wifi@library=${thresholdFor('wifi', 'library')}, canvas/web_portal=${thresholdFor('web_portal', '')}, classroom_av=${thresholdFor('classroom_av', '')}  (labelled placeholders)`);
  line('  request-path search counts existing tickets: at the ceiling, the next report is deflected.');
  line(`  matchScoreThreshold ....... ${DEMO_GATE.matchScoreThreshold}   (DEMO value — UNSET in source)`);
  line(`  matchTimeWindowMinutes .... ${DEMO_GATE.matchTimeWindowMinutes}   (DEMO value — UNSET in source)`);
  line(`  maxReportsPerIdentity ..... ${DEMO_THROTTLE.maxReportsPerIdentity}    (DEMO value — UNSET in source)`);

  rule(`1. The count rule: the first ${CLUSTER_THRESHOLD} wifi reports each get a ticket.`);
  line('  Each reporter becomes visible to the next search once their ticket is filed.');
  line(`  Until ${CLUSTER_THRESHOLD} matching tickets already exist, reports continue filing — that volume is how ITS learns something`);
  line('  is happening.');

  for (let i = 1; i <= CLUSTER_THRESHOLD; i++) {
    await report(`student-${i}`, 'the wifi in North Residence Hall keeps dropping');
  }

  rule(`2. The ${CLUSTER_THRESHOLD + 1}th reporter is deflected — and offered recourse.`);
  line(`  By now ${CLUSTER_THRESHOLD} distinct reporters are on the record, which MEETS the`);
  line('  ceiling. Note the wording: it says other people reported something similar');
  line('  and tickets are open. It does NOT say "known issue" or "wifi is down" — this');
  line('  volume is not an outage, and this service is not a source of truth about');
  line('  campus infrastructure.');

  const clusterMatchId = await report(`student-${CLUSTER_THRESHOLD + 1}`, 'the wifi in North Residence Hall keeps dropping');

  rule('3. The override — "this is not my issue".');
  line('  The deflect was wrong for this person. They say so, and we file anyway.');
  line('  Every override is a labelled matching error: the only data this system');
  line('  generates about its own match quality, and the only path to setting the');
  line('  thresholds that are currently UNSET.');

  await report(`student-${CLUSTER_THRESHOLD + 1}`, 'the wifi in North Residence Hall keeps dropping', {
    overrideMatchId: clusterMatchId,
  });

  const canvasCeiling = thresholdFor('web_portal', '');
  rule(`4. Per-topic ceilings: Canvas tolerates ${canvasCeiling} filings, not ${CLUSTER_THRESHOLD}.`);
  line('  A campus-wide portal outage floods the queue faster than one building\'s');
  line('  wifi, so its deflection ceiling is higher. The mechanism is identical — only');
  line('  the number changes, and it changes ONLY where filing stops. The deflect reply');
  line('  is the same honest wording; no existing ticket is touched; no outage is claimed.');
  // The stage-1 keyword parser recognizes 'portal' + a breadth word ('across
  // campus' / 'nobody can'); it does not yet know the brand name "Canvas". The
  // scenario is the Canvas/LMS one — phrased so the deterministic parser resolves
  // web_portal + service_wide without a model. (A 'canvas' synonym is a stage-2
  // vocabulary addition, out of scope here.)
  const canvasText = 'the campus portal keeps throwing errors, nobody can get on across campus';
  for (let i = 1; i <= canvasCeiling; i++) {
    await report(`prof-${i}`, canvasText, { peerShape: CANVAS_WIDE });
  }
  line();
  line(`  ${canvasCeiling} distinct reporters have now filed. The next report is the 11th;`);
  line(`  search sees the Canvas ceiling of ${canvasCeiling} already present and deflects it.`);
  line('  A wifi cluster this size would have');
  line(`  been deflected long ago, but Canvas is deliberately set higher.`);
  await report(`prof-${canvasCeiling + 1}`, canvasText, { peerShape: CANVAS_WIDE });

  const projectorCeiling = thresholdFor('classroom_av', 'Lecture Hall');
  rule(`5. Classroom projector pilot: ${projectorCeiling} filings, then the next report is deflected.`);
  const projectorText = 'The projector in Lecture Hall will not turn on';
  for (let i = 1; i <= projectorCeiling; i++) {
    await report(`instructor-${i}`, projectorText, { peerShape: PROJECTOR_CENTER_HALL });
  }
  await report(`instructor-${projectorCeiling + 1}`, projectorText, { peerShape: PROJECTOR_CENTER_HALL });

  rule('6. A declared incident deflects on the FIRST match — the count is never read.');
  const declared: DeclaredIncident = {
    kind: 'declared_incident',
    id: 'INC1001',
    service: 'vpn',
    scope: 'service_wide',
    locations: [],
    building: '',
    room: '',
    symptom: 'auth_failure',
    openedAt: DEMO_NOW.toISOString(),
    matchScore: 0,
    reporterHash: '',
    url: 'https://status.example.edu/incident/INC1001',
    status: 'investigating',
    statusUpdatedAt: DEMO_NOW.toISOString(),
    summary: 'Campus VPN authentication failures',
  };
  incidents.add(declared);
  line('  ITS has declared an incident. One authoritative incident outranks any');
  line('  volume of peer reports — and this is the ONLY reply permitted to say a');
  line('  service is affected, because we are quoting ITS with a timestamp.');
  await report('student-7', 'the VPN keeps asking me to sign in over and over, nobody can get on');

  rule('7. The ticket an ITS agent actually opens.');
  line('  Everything except the description is a bounded catalog value. The');
  line('  description quotes the reporter exactly once and is composed by code —');
  line('  never authored by a model.');
  line();
  const sample = tickets.filed[0];
  for (const [k, v] of Object.entries(sample)) {
    if (k === 'description') continue;
    line(`    ${k.padEnd(19)} ${JSON.stringify(v)}`);
  }
  line();
  line(sample.description.split('\n').map((l) => `    │ ${l}`).join('\n'));

  rule('8. The audit log — the only instrument that can measure this feature.');
  line('  A deflected report never becomes a ticket in ServiceNow, so the question');
  line('  "what fraction of reports were duplicates?" is answerable from this log or');
  line('  from nowhere. Note reporterHash: no raw identity is ever written.');
  line();
  for (const l of system.audit.lines.slice(0, 12)) line(`    ${JSON.stringify(l)}`);
  line(`    … ${system.audit.lines.length} lines total`);

  rule('Summary');
  line(`  Tickets filed .............. ${tickets.filed.length}`);
  line(`  NOC advisories raised ...... ${detector.raised.length}`);
  line(`  Audit lines ................ ${system.audit.lines.length}`);
  line(`  Overrides recorded ......... ${system.audit.lines.filter((l) => l.action === 'overridden').length}`);
  line();
  line('  The LLM is not in this picture yet. At stage 2 exactly one module changes:');
  line('  the parser. Everything you just watched — the gate, the count rule, the');
  line('  wording, the audit trail — is byte-identical across all three stages.');
  line();
}

await main();
