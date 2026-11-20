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
//
// Since Milestone 3 this file is the TICKET ADAPTER of the correlation engine
// (src/correlate.ts): it turns report events into signals {key: groupKey,
// source: reporter hash, time, weight 1} and owns everything the engine does not
// know — the clock, the per-topic threshold, and "raise once, then update".
//
// Known behaviours kept on purpose (M3 council Q10), each a demo-scale shortcut:
// a quiet key's events are never evicted from `seen`; a raised alert never
// expires; `alertId` replaces only the first '|' of the key.

import type { Clock } from './adapters/memory';
import { gateTuning, groupKey, thresholdFor } from './clusterGate';
import type { PatternAlert, ReportEvent } from './contracts/types';
import { correlate } from './correlate';

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

    // The clock decides what is still recent (strictly newer than the cutoff)...
    const kept = [...(this.seen.get(key) ?? []), event].filter((e) => Date.parse(e.ts) > cutoff);
    this.seen.set(key, kept);

    // ...and the engine decides what belongs together. Every kept event is newer
    // than the cutoff, so they normally form ONE group; if a future-dated event
    // ever splits them, the group holding the current event is the one judged.
    const groups = correlate(
      kept.map((e) => ({ key, source: e.reporterHash, time: Date.parse(e.ts), weight: 1 })),
      windowMinutes * 60_000,
    );
    // A late event older than the window is not in `kept`; the others are then
    // judged as before, and with nothing kept there is nothing to judge.
    const current = kept.indexOf(event);
    const group = groups.find((g) => g.members.includes(current)) ?? groups[0];
    if (group === undefined) return null;
    const inGroup = new Set(group.members);
    const events = kept.filter((_, i) => inGroup.has(i)); // arrival order, as before

    // DISTINCT reporters, never report count: the engine counts each source once
    // and every weight is 1. One person reporting five times is one reporter.
    const distinctReporters = group.score;
    // The same per-topic ceiling used by request-path deflection, but a deliberately
    // different comparison because this stream includes the CURRENT report event.
    // Request search deflects when existing peers >= threshold; this detector then
    // sees those peers plus the current accepted/deflected report and alerts when
    // stream reporters > threshold. Both happen on the same interaction.
    const threshold = thresholdFor(event.service, event.scope === 'service_wide' ? '' : event.location);
    // The ticket rule: strictly MORE distinct reporters than the topic's threshold.
    if (distinctReporters <= threshold) return null;

    const shared = {
      service: event.service,
      location: event.scope === 'service_wide' ? '' : event.location,
      building: event.building ?? '',
      room: event.room ?? '',
      windowMinutes,
      distinctReporters,
      firstReportAt: kept[group.members[0]].ts,
      lastReportAt: kept[group.members[group.members.length - 1]].ts,
      ticketNumbers: events.map((e) => e.ticketNumber).filter((t) => t !== ''),
      sampleCorrelationIds: events.map((e) => e.correlationId).slice(0, 5),
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
