// Interactive terminal demo — accept free-text problem reports and print the
// parsed record, decision, and reply. For live demos where the audience submits
// whatever they want.
//
//   npm run demo:live
//
// If LLM_API_URL / LLM_API_KEY / LLM_MODEL are set, the stage-2 LLM
// parser is wired. Otherwise the keyword parser runs. Use Ctrl+C or "quit".

import * as readline from 'node:readline';

import type { OrchestratorDeps } from '../src/orchestrator';
import type { AuditLine } from '../src/audit';
import { buildStage2, type System } from '../src/composition';
import { postReport } from '../src/api';
import type { PeerTicket } from '../src/contracts/types';
import type { TicketScope } from '../src/vocab/catalog';

let counter = 0;
let filedOutcomes = 0;

function freshIdentity(): string {
  return `interactive-${++counter}`;
}

function latestParsedLog(deps: OrchestratorDeps): AuditLine | undefined {
  const lines = deps.audit.lines;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].action === 'parsed') return lines[i];
  }
  return undefined;
}

const TICKET_SCOPES: readonly string[] = ['individual', 'location', 'service_wide'];

function castScope(raw: string): TicketScope {
  return TICKET_SCOPES.includes(raw) ? (raw as TicketScope) : 'individual';
}

async function seedPeer(deps: OrchestratorDeps, ticketNumber: string, url: string): Promise<void> {
  const incidentSource = deps.incidents as OrchestratorDeps['incidents'] & {
    add?: (candidate: PeerTicket) => void;
  };
  if (typeof incidentSource.add !== 'function') return;

  const parsed = latestParsedLog(deps);
  if (parsed === undefined) return;
  const { hash } = await deps.identity.resolve(freshIdentity());
  const peer: PeerTicket = {
    kind: 'peer_ticket',
    id: ticketNumber,
    service: parsed.service ?? 'unknown',
    scope: castScope(parsed.scope ?? 'unknown'),
    locations: parsed.location ? [parsed.location] : [],
    building: parsed.building ?? '',
    room: parsed.room ?? '',
    symptom: parsed.symptom ?? 'unknown',
    openedAt: new Date().toISOString(),
    matchScore: 0,
    reporterHash: hash,
    url,
  };
  incidentSource.add(peer);
}

async function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

async function main(): Promise<void> {
  const system: System = buildStage2();
  const { deps, detector, audit } = system;

  process.stdout.write('\n  Campus Issue Reporter — interactive demo\n');
  process.stdout.write(`  stage-${deps.stage}  `);
  process.stdout.write(deps.stage === 2 ? '(LLM parser wired)\n' : '(keyword parser)\n');
  process.stdout.write('  Type a problem description. "quit" exits, "stats" prints counters.\n\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  for (;;) {
    const text = await ask(rl, '  > ');
    if (text === '') continue;
    if (text === 'quit' || text === 'exit') break;

    if (text === 'stats') {
      process.stdout.write(
        `    filed outcomes: ${filedOutcomes}  NOC advisories: ${detector.raised.length}  audit lines: ${audit.lines.length}\n\n`,
      );
      continue;
    }

    const reqStart = audit.lines.length;
    const { status, body } = await postReport(
      { text, identityRef: freshIdentity(), canFollowUp: true },
      deps,
    );

    const justWritten = audit.lines.slice(reqStart).filter((l) => l.action === 'parsed');
    const justWrittenOverrides = audit.lines.slice(reqStart).filter((l) => l.action === 'overridden');

    if (body.ticket !== undefined) {
      filedOutcomes++;
      await seedPeer(deps, body.ticket.ticketNumber, body.ticket.url);
    }

    const parts: string[] = [
      '',
      `    HTTP ${status}`,
      `    outcome  : ${body.outcome}`,
    ];

    for (const pw of justWritten) {
      parts.push(
        `    parse    : ${pw.parseSource ?? '?'} → service=${pw.service ?? '?'} scope=${pw.scope ?? '?'} symptom=${pw.symptom ?? '?'} location="${pw.location ?? ''}"`,
      );
      if (pw.repairAttempted === true) parts.push('    repair   : attempted');
    }

    parts.push(`    reply    : ${body.reply}`);
    if (body.ticket !== undefined) parts.push(`    ticket   : ${body.ticket.ticketNumber}`);
    if (body.incident !== undefined)
      parts.push(`    incident : ${body.incident.id}  status=${body.incident.status}`);
    if (body.cluster !== undefined)
      parts.push(
        `    cluster  : ${body.cluster.reportCount} reporters, tickets: ${body.cluster.ticketIds.join(', ')}`,
      );
    if (body.override !== undefined) parts.push(`    override : ${body.override.matchId}`);
    if (body.missingFields !== undefined)
      parts.push(`    missing  : ${body.missingFields.join(', ')}`);

    for (const o of justWrittenOverrides) {
      parts.push(`    feedback : overridden match=${o.overriddenMatchId} score=${o.overriddenScore}`);
    }

    parts.push('');
    process.stdout.write(parts.join('\n'));
  }

  rl.close();
  process.stdout.write(
    `\n  Done. ${filedOutcomes} filed outcomes, ${audit.lines.length} audit lines.\n\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`\n  fatal: ${error instanceof Error ? error.message : 'unknown'}\n\n`);
  process.exit(1);
});
