// The SECURITY-ALERT adapter of the correlation engine (Milestone 3).
//
// It reads alerts from Skipa776/detection-engineering-ml (contract: the vendored
// vendor/detection-engineering-ml/alert.schema.json, version 1.0) and groups them
// into incident CANDIDATES: several distinct detectors firing on one host inside
// one window. Advisory only, like the ticket side's PatternAlert: nothing here
// creates a ticket, calls a network, or sends alert text to a model.
//
// Alert content is untrusted (hostnames, titles and command lines come from the
// logs an attacker touched). So the guard below is STRICTER than the schema, the
// parsed type keeps only what grouping needs, and `ground_truth` is never read.

import { correlate, type Group } from './correlate';

// ── DEMO constants: placeholders, fixed on 2026-11-20 BEFORE any evaluation ────
// (docs/DECISIONS.md M3-Q7). Not measured, not tuned; like clusterGate's numbers.
/** One hour of time_observed per group, anchored at the group's first alert. */
export const DEMO_WINDOW_MS = 60 * 60_000;
/** A group is a candidate when at least this many DISTINCT detectors fired. */
export const DEMO_MIN_DETECTORS = 2;

// ── The guard: fail closed, skip and count ───────────────────────────────────
const MAX_LINE_BYTES = 64 * 1024;
const MAX_DETECTOR_ID = 128;
/** Hosts become keys and printed text; anything outside this is skipped, never rewritten. */
const HOST = /^[A-Za-z0-9._-]{1,64}$/;
const ALERT_ID = /^[0-9a-f]{64}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TECHNIQUE = /^T\d{4}(\.\d{3})?$/;
const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

/** Only what grouping and display need. No evidence, title, user, process, correlation_key or ground_truth. */
export type Alert = {
  readonly alertId: string; // opaque reference, pattern-checked; never used to group
  readonly host: string;
  readonly detectorId: string;
  readonly detectorName: string;
  readonly detectorAuthor: string | null; // Sigma rule author: the DRL 1.1 requires attribution
  readonly detectorType: 'sigma' | 'anomaly';
  readonly time: number; // epoch ms of time_observed
  readonly severity: (typeof SEVERITIES)[number];
  readonly techniques: readonly string[];
};

const str = (v: unknown, max = Infinity): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** One JSONL line → an Alert, or null to skip it. Never throws. */
export function parseAlertLine(line: string): Alert | null {
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const a = raw as Record<string, unknown> | null;
  if (typeof a !== 'object' || a === null) return null;
  // Any other version could mean anything: refuse it instead of half-reading it.
  if (a.schema_version !== '1.0' || a.source !== 'detection-engineering-ml') return null;
  const detector = a.detector as Record<string, unknown> | null;
  const entity = a.entity as Record<string, unknown> | null;
  if (typeof detector !== 'object' || detector === null || typeof entity !== 'object' || entity === null) return null;
  if (!str(a.alert_id) || !ALERT_ID.test(a.alert_id)) return null;
  if (detector.type !== 'sigma' && detector.type !== 'anomaly') return null;
  if (!str(detector.id, MAX_DETECTOR_ID) || !str(detector.name)) return null;
  if (!(detector.author === null || typeof detector.author === 'string')) return null;
  if (!str(entity.host) || !HOST.test(entity.host)) return null;
  if (!str(a.time_observed) || !TIME.test(a.time_observed) || Number.isNaN(Date.parse(a.time_observed))) return null;
  if (!SEVERITIES.includes(a.severity as (typeof SEVERITIES)[number])) return null;
  if (!Array.isArray(a.techniques) || !a.techniques.every((t) => typeof t === 'string' && TECHNIQUE.test(t))) return null;
  return {
    alertId: a.alert_id,
    host: entity.host,
    detectorId: detector.id,
    detectorName: detector.name,
    detectorAuthor: detector.author as string | null,
    detectorType: detector.type,
    time: Date.parse(a.time_observed),
    severity: a.severity as Alert['severity'],
    techniques: a.techniques as string[],
  };
}

/** Every line of a JSONL file, parsed; skipped lines are counted, never guessed at. */
export function parseAlerts(jsonl: string): { alerts: Alert[]; skipped: number } {
  const alerts: Alert[] = [];
  let skipped = 0;
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue;
    const alert = parseAlertLine(line);
    if (alert === null) skipped++;
    else alerts.push(alert);
  }
  return { alerts, skipped };
}

// ── Grouping ─────────────────────────────────────────────────────────────────

export type IncidentCandidate = {
  readonly host: string;
  readonly firstTime: number;
  readonly lastTime: number;
  readonly distinctDetectors: number;
  readonly detectors: readonly { readonly id: string; readonly name: string; readonly author: string | null }[];
  readonly severities: readonly Alert['severity'][];
  readonly techniques: readonly string[];
  readonly alertIds: readonly string[];
};

/**
 * Alerts → signals: key = lowercased host, source = detector id (one rule firing
 * on 79 events is still one detector), time = time_observed, weight = 1 (the
 * headline rule is unweighted, council M3-Q4).
 */
export function alertGroups(alerts: readonly Alert[], windowMs = DEMO_WINDOW_MS): Group[] {
  return correlate(
    alerts.map((a) => ({ key: a.host.toLowerCase(), source: a.detectorId, time: a.time, weight: 1 })),
    windowMs,
  );
}

/** The alerts in no candidate, one entry per host, so none of them drops out of sight. */
export type UngroupedHost = { readonly host: string; readonly alerts: number; readonly topSeverity: Alert['severity'] };

const moreSevere = (a: Alert['severity'], b: Alert['severity']): number => SEVERITIES.indexOf(b) - SEVERITIES.indexOf(a);

/**
 * The groups worth a human's look, most severe first, plus every alert left out
 * of them, by host. Ties break on time and host, so input order never matters.
 */
export function incidentCandidates(alerts: readonly Alert[]): {
  candidates: IncidentCandidate[];
  alertsInNoCandidate: number;
  ungroupedHosts: UngroupedHost[];
} {
  // The alert rule: at least DEMO_MIN_DETECTORS distinct detectors in one window.
  const firing = alertGroups(alerts).filter((g) => g.score >= DEMO_MIN_DETECTORS);
  const candidates = firing.map((g) => {
    const members = g.members.map((i) => alerts[i]);
    const detectors = new Map(members.map((a) => [a.detectorId, { id: a.detectorId, name: a.detectorName, author: a.detectorAuthor }]));
    return {
      host: members[0].host,
      firstTime: g.firstTime,
      lastTime: g.lastTime,
      distinctDetectors: g.score,
      detectors: [...detectors.values()],
      severities: [...new Set(members.map((a) => a.severity))].sort(moreSevere),
      techniques: [...new Set(members.flatMap((a) => a.techniques))],
      alertIds: members.map((a) => a.alertId),
    };
  });
  candidates.sort((a, b) => moreSevere(a.severities[0], b.severities[0]) || a.firstTime - b.firstTime || (a.host < b.host ? -1 : 1));

  const inCandidate = new Set(firing.flatMap((g) => g.members));
  // Grouped by lowercased host, like the candidates; shown in the host's own spelling
  // (the first in sort order, so input order cannot change it).
  const byHost = new Map<string, { host: string; severities: Alert['severity'][] }>();
  alerts.forEach((a, i) => {
    if (inCandidate.has(i)) return;
    const seen = byHost.get(a.host.toLowerCase());
    byHost.set(a.host.toLowerCase(), {
      host: seen === undefined || a.host < seen.host ? a.host : seen.host,
      severities: [...(seen?.severities ?? []), a.severity],
    });
  });
  const ungroupedHosts = [...byHost.values()].map(({ host, severities }) => ({ host, alerts: severities.length, topSeverity: severities.sort(moreSevere)[0] }));
  ungroupedHosts.sort((a, b) => moreSevere(a.topSeverity, b.topSeverity) || b.alerts - a.alerts || (a.host < b.host ? -1 : 1));
  return { candidates, alertsInNoCandidate: alerts.length - inCandidate.size, ungroupedHosts };
}
