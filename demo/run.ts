// The stage-1 demo driver — the thin local harness api_contract.md calls for.
//
// Run it with `npm run demo`. No credentials, no network, no configuration: that
// property IS stage 1, so if this ever needs an API key, something has drifted.
//
// The script is deliberately a narrative rather than a menu. It walks flood
// control (the first report creates ONE parent incident, every later report
// links to it locally), the priority recommendation, the override, and the
// declared-incident deflect.

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

const WIFI_NORTH_HALL: PeerShape = {
  service: 'wifi',
  scope: 'location',
  locations: ['North Residence Hall'],
  symptom: 'intermittent',
};
const PROJECTOR_LECTURE_HALL: PeerShape = {
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
  const { overrideMatchId, peerShape = WIFI_NORTH_HALL } = opts ?? {};
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

/** What the flood ledger holds right now: one line per parent incident. */
function printLedger(): void {
  for (const parent of system.ledger.all()) {
    line();
    line(`  ▤ LEDGER ${parent.ticketNumber}: ${parent.reporters.size} distinct reporters, created at P${parent.priority.priority} (policy rule ${parent.priority.ruleId})`);
    const rec = parent.recommendation;
    line(
      rec === null
        ? '    no priority recommendation pending'
        : `    pending recommendation: raise to P${rec.priority} (policy rule ${rec.ruleId}, at ${rec.distinctReporters} reporters) — a human applies it; nothing updates the ticket`,
    );
  }
}

async function main(): Promise<void> {
  rule('Stage 1 — deterministic demo. No credentials, no network.');
  line(`  priority policy ........... ${deps.policy.name}   (SYNTHETIC example)`);
  line(`  matchScoreThreshold ....... ${DEMO_GATE.matchScoreThreshold}   (DEMO value — UNSET in source)`);
  line(`  matchTimeWindowMinutes .... ${DEMO_GATE.matchTimeWindowMinutes}   (DEMO value — UNSET in source; also the link window)`);
  line(`  maxReportsPerIdentity ..... ${DEMO_THROTTLE.maxReportsPerIdentity}    (DEMO value — UNSET in source)`);
  line(`  NOC advisory ceilings ..... default=${CLUSTER_THRESHOLD}, wifi@library=${thresholdFor('wifi', 'library')}, web_portal=${thresholdFor('web_portal', '')}, classroom_av=${thresholdFor('classroom_av', '')}  (labelled placeholders)`);

  const wifiText = 'the wifi in North Residence Hall keeps dropping';
  rule('1. Flood control: the first report creates ONE parent incident.');
  line('  Its priority comes from the policy table — never from a model — and is');
  line('  written once, at create.');
  await report('student-1', wifiText);
  line(`  → priority set: P${tickets.filed[0].priority?.priority} by policy rule ${tickets.filed[0].priority?.ruleId}`);

  rule('2. Every later report links to the parent. Nothing else is created.');
  line('  The link and the count live in this service\'s own ledger. The wording says');
  line('  other people reported something similar. It does NOT say "known issue" or');
  line('  "wifi is down" — volume is not an outage.');
  let lastMatchId = '';
  for (let i = 2; i <= 6; i++) lastMatchId = await report(`student-${i}`, wifiText);
  printLedger();

  rule('3. The override — "this is not my issue".');
  line('  The link was wrong for this person. They say so, and we file anyway. The');
  line('  override does not join or replace the parent. Every override is a labelled');
  line('  matching error: the only data this system generates about its own match quality.');
  await report('student-6', wifiText, { overrideMatchId: lastMatchId });

  rule('4. Same rule for a classroom projector: one INC, then links.');
  const projectorText = 'The projector in Lecture Hall will not turn on';
  for (let i = 1; i <= 4; i++) await report(`instructor-${i}`, projectorText, { peerShape: PROJECTOR_LECTURE_HALL });
  printLedger();

  rule('5. A declared incident deflects on the FIRST match — the count is never read.');
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
  line('  IT has declared an incident. One authoritative incident outranks any');
  line('  volume of peer reports — and this is the ONLY reply permitted to say a');
  line('  service is affected, because we are quoting IT with a timestamp.');
  await report('student-7', 'the VPN keeps asking me to sign in over and over, nobody can get on');

  rule('6. The ticket an IT agent actually opens.');
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

  rule('7. The audit log — the only instrument that can measure this feature.');
  line('  A linked report never becomes a ticket in ServiceNow, so the question');
  line('  "what fraction of reports were duplicates?" is answerable from this log or');
  line('  from nowhere. Note reporterHash: no raw identity is ever written.');
  line();
  for (const l of system.audit.lines.slice(0, 12)) line(`    ${JSON.stringify(l)}`);
  line(`    … ${system.audit.lines.length} lines total`);

  rule('Summary');
  line(`  Tickets filed .............. ${tickets.filed.length}`);
  line(`  Reports linked to a parent . ${system.audit.lines.filter((l) => l.action === 'linked').length}`);
  line(`  Pending recommendations .... ${system.ledger.all().filter((p) => p.recommendation !== null).length}`);
  line(`  NOC advisories raised ...... ${detector.raised.length}`);
  line(`  Audit lines ................ ${system.audit.lines.length}`);
  line(`  Overrides recorded ......... ${system.audit.lines.filter((l) => l.action === 'overridden').length}`);
  line();
  line('  The LLM is not in this picture yet. At stage 2 exactly one module changes:');
  line('  the parser. Everything you just watched — create or link, the priority, the');
  line('  wording, the audit trail — is decided by the same deterministic code.');
  line();
}

await main();
