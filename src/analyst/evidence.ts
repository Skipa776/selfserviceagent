import { createHash } from 'node:crypto';

import type { ReportEvent } from '../contracts/types';
import type { AnalystEvidenceSnapshot } from './contracts';

export function topicKeyFor(event: ReportEvent): string {
  const room = event.service === 'classroom_av' ? event.room : '';
  return [event.service, event.scope, event.building, room, event.symptom].join('|');
}

function stableSnapshotId(topicKey: string, events: readonly ReportEvent[]): string {
  const body = events.map((event) => [
    event.correlationId,
    event.ts,
    event.reporterHash,
    event.outcome,
    event.ticketNumber,
    event.viaOverride,
  ]);
  return `snap-${createHash('sha256').update(JSON.stringify([topicKey, body])).digest('hex').slice(0, 16)}`;
}

export function buildEvidenceSnapshots(
  source: readonly ReportEvent[],
  generatedAt: string,
): AnalystEvidenceSnapshot[] {
  const byCorrelation = new Map<string, ReportEvent>();
  for (const event of source) {
    const existing = byCorrelation.get(event.correlationId);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(event)) {
      throw new Error(`conflicting analyst event ${event.correlationId}`);
    }
    byCorrelation.set(event.correlationId, event);
  }

  const groups = new Map<string, ReportEvent[]>();
  for (const event of byCorrelation.values()) {
    const key = topicKeyFor(event);
    const events = groups.get(key) ?? [];
    events.push(event);
    groups.set(key, events);
  }

  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([topicKey, unordered]) => {
    const events = [...unordered].sort((a, b) => a.ts.localeCompare(b.ts) || a.correlationId.localeCompare(b.correlationId));
    const first = events[0];
    if (first === undefined) throw new Error('empty analyst event group');
    const filed = new Set(events.filter((event) => event.ticketNumber !== '').map((event) => event.reporterHash));
    const overflow = new Set(events.filter((event) => event.outcome === 'MATCHED_CLUSTER').map((event) => event.reporterHash));
    const overrides = new Set(events.filter((event) => event.viaOverride).map((event) => event.reporterHash));
    const total = new Set(events.map((event) => event.reporterHash));

    return {
      snapshotId: stableSnapshotId(topicKey, events),
      generatedAt,
      topicKey,
      service: first.service,
      scope: first.scope,
      location: first.location,
      building: first.building,
      room: first.room,
      symptom: first.symptom,
      firstReportAt: events[0]?.ts ?? '',
      lastReportAt: events.at(-1)?.ts ?? '',
      filedDistinct: filed.size,
      overflowDistinct: overflow.size,
      overrideDistinct: overrides.size,
      totalDistinct: total.size,
      filedTicketNumbers: events.map((event) => event.ticketNumber).filter((ticket) => ticket !== ''),
      evidence: events.map((event, index) => ({
        id: `E${index + 1}`,
        correlationId: event.correlationId,
        reporterHash: event.reporterHash,
        outcome: event.outcome,
        ticketNumber: event.ticketNumber,
        viaOverride: event.viaOverride,
        ts: event.ts,
      })),
    };
  });
}
