// Cluster gate constants — the ONE module that owns them (cluster_gate.md).
// Nothing else in the system holds a score comparison, a minute count, or the
// number 5 near a match check. decide() and the pattern detector import from here;
// the orchestrator reads the window from here to compute `withinWindow`.

// CLUSTER_THRESHOLD carries a value because the deterministic core cannot be
// demonstrated without one, and 5 is defensible enough to build and demo against —
// but NOT to ship (cluster_gate.md). It is ALSO the NOC alert ceiling: request
// search deflects when N matching tickets already exist, and the resulting current
// report event takes the detector stream to N+1 and alerts NOC. It is one ceiling,
// not two independently tuned numbers (pattern_alert.md).
//
// SEMANTICS — the threshold is an EXISTING-CLUSTER ceiling: once there are this
// many matching distinct reporters already on the record, the NEXT report is
// deflected instead of filed. So CLUSTER_THRESHOLD = 5 means "if 5 matching
// tickets already exist, do not create a 6th".
//
// That creates a deliberate difference between the request-path gate and the async
// detector:
//   decide():          compares EXISTING peers from search      -> >= threshold
//   pattern detector:  counts the CURRENT report in its stream  -> >  threshold
//
// Same practical event, different count origins.
export const CLUSTER_THRESHOLD = 5; // PLACEHOLDER — see cluster_gate.md

// ── Per-topic thresholds — the "hard-coded values document", in the one module ──
// Some topics generate far more duplicates than others: a campus-wide portal
// outage floods the queue faster than one building's wifi. This table lets the
// deflection point vary by topic while keeping EVERY threshold literal in this one
// module (cluster_gate.md invariant: nothing else holds the number near a match
// check). It changes only WHEN deflection begins — never WHAT the deflect reply
// says (that stays the honest MATCHED_CLUSTER wording; boundaries.md boundary 2)
// and never touches an existing ticket (boundaries.md boundary 1).
//
//   !! THESE NUMBERS ARE PLACEHOLDERS, exactly like CLUSTER_THRESHOLD. !!
//   3 / 5 / 10 are working demo values, not measured ones. Shipping them without the
//   evidence that resolves them is the same failure the base
//   constant's comment names.
//
// Keys are CATALOG vocabulary (vocab/catalog.ts). Canvas is a `web_portal`
// service; "library wifi" is `wifi` scoped to a `library` location. `location` is
// a free-text passthrough token (catalog.ts deliberately does not enumerate it),
// so matching it here is a substring-free exact compare after trimming and
// lowercasing both location tokens.
type TopicThreshold = {
  /** Catalog service this rule applies to. Required. */
  readonly service: string;
  /** Parsed location token; omit to match the service regardless of location. */
  readonly location?: string;
  /** Existing matching distinct reporters that are enough to deflect the NEXT report. */
  readonly threshold: number;
};

const TOPIC_THRESHOLDS: readonly TopicThreshold[] = [
  // Classroom AV: three matching equipment reports already open are enough to
  // suppress the next report. PLACEHOLDER pending real pilot evidence.
  { service: 'classroom_av', threshold: 3 },
  // Library wifi: one building. If 5 matching tickets already exist, suppress the
  // next one (same as the base default, stated explicitly so the demo can point at it).
  { service: 'wifi', location: 'library', threshold: 5 },
  // Canvas / the LMS portal: campus-wide, tolerate more existing tickets before
  // suppressing the next one because the first wave of reports is how IT learns
  // the scale.
  { service: 'web_portal', threshold: 10 },
];

/**
 * The per-topic existing-cluster ceiling for a report. Falls back to CLUSTER_THRESHOLD
 * when no topic rule matches. A location-specific rule (both service AND location)
 * outranks a service-only rule for the same service.
 *
 * Returns the number of EXISTING matching distinct reporters that is enough to
 * suppress the NEXT report. The request-path gate deflects at
 * `existingDistinctReporters >= thresholdFor(...)`.
 */
export function thresholdFor(service: string, location: string): number {
  const normalizedLocation = location.trim().toLowerCase();
  const withLocation = TOPIC_THRESHOLDS.find(
    (t) =>
      t.service === service &&
      t.location !== undefined &&
      t.location.trim().toLowerCase() === normalizedLocation,
  );
  if (withLocation !== undefined) return withLocation.threshold;

  const serviceOnly = TOPIC_THRESHOLDS.find((t) => t.service === service && t.location === undefined);
  if (serviceOnly !== undefined) return serviceOnly.threshold;

  return CLUSTER_THRESHOLD;
}

// MATCH_SCORE_THRESHOLD and MATCH_TIME_WINDOW_MINUTES are the two UNSET constants.
// Source ships NO default: each resolves only from real data that does not exist
// yet (a labelled match sample; the real "notice minus opened" lag). A default here
// is how a placeholder silently becomes a production threshold nobody chose
// They are injected rather than silently defaulted in production logic.
// by the composition root with clearly-labelled DEMO values, and by tests — through
// configureGate(). Reading them before injection THROWS, loudly, at startup.
export type GateTuning = {
  /** A candidate counts as a match only at or above this score. Boundary inclusive. */
  readonly matchScoreThreshold: number;
  /** ...and only if it was opened within this many minutes of now. */
  readonly matchTimeWindowMinutes: number;
};

let tuning: GateTuning | null = null;

/** Inject the two UNSET constants. Called once at the composition root, and by tests. */
export function configureGate(t: GateTuning): void {
  tuning = t;
}

/** Read the injected tuning. Throws if unset; production defaults are intentionally absent. */
export function gateTuning(): GateTuning {
  if (tuning === null) {
    throw new Error(
      'cluster gate not configured: inject MATCH_SCORE_THRESHOLD and ' +
        'MATCH_TIME_WINDOW_MINUTES via configureGate() before use; source ships no default.',
    );
  }
  return tuning;
}

/** Test/harness helper: clear injected tuning so a later "unset" path is testable. */
export function resetGate(): void {
  tuning = null;
}
