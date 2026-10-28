// Pattern detector — the emerging-incident early warning
// (components/pattern_detector.md).
//
// Individually, one person saying "wifi in North Residence Hall keeps dropping" is a ticket. Five
// people saying it inside the window is something nobody has declared yet. This
// is the only part of the system that can see the difference, and its entire
// output is one advisory alert.
//
// It runs OFF the request path, over events the orchestrator already published.
// If it is down, users still get correct answers and correct tickets — they lose
// the early warning. That is the right failure ordering, and it is why the
// fan-out is fire-and-forget rather than a step in the sequence.
//
// What it must never do: declare, open, escalate or resolve an incident; become a
// status source; read the ticketing system; de-anonymize anyone. `status` is
// always 'candidate' — the type has no other value, so a human at NOC decides.

import type { Clock } from './adapters/memory';
import { gateTuning, thresholdFor } from './clusterGate';
import type { PatternAlert, ReportEvent } from './contracts/types';

/**
 * Group key. `service_wide` events group under a LOCATION-LESS key for that
 * service and do not contribute to any single location's count — letting them do
 * both would let one campus-wide report inflate every building simultaneously.
 */
function groupKey(e: ReportEvent): string {
  if (e.scope === 'service_wide') return `${e.service}|`;
  if (e.service === 'classroom_av') return `${e.service}|${e.building ?? ''}|${e.room ?? ''}`;
  return `${e.service}|${e.building ?? ''}`;
}

export class PatternDetector {
  private readonly seen = new Map<string, ReportEvent[]>();
  private readonly alerts = new Map<string, PatternAlert>();

  constructor(private readonly clock: Clock) {}

  /** Every alert raised so far, in creation order. */
  get raised(): readonly PatternAlert[] {
    return [...this.alerts.values()];
  }

  /**
   * Consume one event. Returns a NEW alert if this event crossed the threshold
   * for its group, otherwise null — including when it merely updated an alert
   * that already exists. An early-warning channel that pages once per additional
   * reporter is a channel that gets muted, and a muted channel is worth less
   * than none.
   */
  consume(event: ReportEvent): PatternAlert | null {
    // The same window the gate uses. Reading it from cluster_gate rather than
    // holding a second minute-count is the "no second timer to keep in sync" rule.
    const windowMinutes = gateTuning().matchTimeWindowMinutes;
    const key = groupKey(event);
    const cutoff = this.clock().getTime() - windowMinutes * 60_000;

    const kept = [...(this.seen.get(key) ?? []), event].filter((e) => Date.parse(e.ts) > cutoff);
    this.seen.set(key, kept);

    // DISTINCT reporters, never report count. One person reporting five times is
    // one reporter; without this the alert path is trivially abusable by a single
    // identity, and the throttle would be the only thing in the way.
    const distinctReporters = new Set(kept.map((e) => e.reporterHash)).size;
    // The same per-topic ceiling used by request-path deflection, but a deliberately
    // different comparison because this stream includes the CURRENT report event.
    // Request search deflects when existing peers >= threshold; this detector then
    // sees those peers plus the current accepted/deflected report and alerts when
    // stream reporters > threshold. Both happen on the same interaction.
    const threshold = thresholdFor(event.service, event.scope === 'service_wide' ? '' : event.location);
    if (distinctReporters <= threshold) return null;

    const timestamps = kept.map((e) => e.ts).sort();
    const shared = {
      service: event.service,
      location: event.scope === 'service_wide' ? '' : event.location,
      building: event.building ?? '',
      room: event.room ?? '',
      windowMinutes,
      distinctReporters,
      firstReportAt: timestamps[0],
      lastReportAt: timestamps[timestamps.length - 1],
      ticketNumbers: kept.map((e) => e.ticketNumber).filter((t) => t !== ''),
      sampleCorrelationIds: kept.map((e) => e.correlationId).slice(0, 5),
      status: 'candidate' as const,
    };

    const existing = this.alerts.get(key);
    if (existing !== undefined) {
      // Update, do not re-raise.
      this.alerts.set(key, { ...shared, alertId: existing.alertId });
      return null;
    }

    const alert: PatternAlert = { ...shared, alertId: `ALERT-${key.replace('|', '-') || 'campus'}` };
    this.alerts.set(key, alert);
    return alert;
  }
}
