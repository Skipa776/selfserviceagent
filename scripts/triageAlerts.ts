// `npm run triage:alerts -- <alerts.jsonl>` — prints the incident candidates in
// a file of detection-engineering-ml alerts. Offline, read-only, advisory: it
// creates nothing and sends nothing anywhere.
//
// Untrusted text is printed only after stripping control and bidi characters
// and capping its length; titles, command lines and other evidence are never
// printed (council M3-Q10). Every Sigma detector is printed with its author, as
// the Detection Rule License 1.1 requires of messages based on rule matches.

import { readFileSync } from 'node:fs';

import { DEMO_MIN_DETECTORS, DEMO_WINDOW_MS, incidentCandidates, parseAlerts } from '../src/alertAdapter';

const MAX_PRINTED = 120;

/** Printable characters only: no control codes (C0/C1), no bidi overrides, capped. */
export function printable(text: string): string {
  const kept = [...text].filter((c) => {
    const code = c.codePointAt(0) ?? 0;
    const control = code < 32 || (code >= 127 && code <= 159);
    const bidi = (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    return !control && !bidi;
  });
  return kept.join('').slice(0, MAX_PRINTED);
}

function main(): number {
  const path = process.argv[2];
  let jsonl: string;
  try {
    jsonl = readFileSync(path ?? '', 'utf8');
  } catch {
    process.stderr.write('usage: npm run triage:alerts -- <alerts.jsonl>  (file not readable)\n');
    return 1;
  }
  const { alerts, skipped } = parseAlerts(jsonl);
  const { candidates, alertsInNoCandidate, ungroupedHosts } = incidentCandidates(alerts);
  const out = (s = ''): void => {
    process.stdout.write(`${s}\n`);
  };

  out(`${alerts.length} alerts read, ${skipped} lines skipped by the guard.`);
  out(`Rule: >= ${DEMO_MIN_DETECTORS} distinct detectors on one host within ${DEMO_WINDOW_MS / 60_000} minutes (DEMO values).`);
  out(`${candidates.length} incident candidates (most severe first); ${alertsInNoCandidate} alerts on ${ungroupedHosts.length} hosts are in no candidate.`);
  for (const c of candidates) {
    out();
    out(`■ ${printable(c.host)}  ${new Date(c.firstTime).toISOString()} → ${new Date(c.lastTime).toISOString()}`);
    out(`  ${c.distinctDetectors} detectors, ${c.alertIds.length} alerts, severities: ${c.severities.join(', ')}, techniques: ${c.techniques.join(', ') || 'none'}`);
    for (const d of c.detectors) out(`  - ${printable(d.name)}${d.author === null ? '' : ` (rule by ${printable(d.author)})`}`);
  }
  if (ungroupedHosts.length > 0) {
    out();
    out('In no candidate, by host (most severe first):');
    for (const u of ungroupedHosts) out(`  ${printable(u.host)}: ${u.alerts} ${u.alerts === 1 ? 'alert' : 'alerts'}, top severity ${u.topSeverity}`);
  }
  out();
  out('Advisory only: a human decides. A host with no candidate is not a clean bill of health.');
  return 0;
}

if (process.argv[1]?.endsWith('triageAlerts.ts')) process.exit(main());
