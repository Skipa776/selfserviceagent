// Throttle limits — the ONE module that owns them (safety/report_throttle.md,
// "Limits live in exactly one module and are imported, not re-literalled").
//
// All THREE are UNSET. Source ships no default, for the same reason as
// cluster_gate.md's two: no data exists on how often a legitimate user reports a
// problem. Set too low and the service refuses someone whose wifi genuinely
// dropped three times in an hour — a real, common, correct thing to report. Set
// too high and it is not a control. A default written here is how a placeholder
// silently becomes the production limit nobody chose.
//
// Injected by the composition root (with clearly-labelled DEMO values) and by
// tests, through configureThrottle(). Reading before injection THROWS, loudly.
//
// The window is also the idempotency retention window (orchestrator.md,
// "Retention window = the throttle window — one place, one duration, no second
// timer to keep in sync").

export type ThrottleLimits = {
  /** Rolling window all three limits are measured over. */
  readonly windowMinutes: number;
  /** Max reports one reporterHash may file per window. */
  readonly maxReportsPerIdentity: number;
  /**
   * Max distinct services one reporterHash may report per window. Exists because
   * a flooder's cheapest evasion is variety: five reports across five services
   * look less repetitive than five identical ones.
   */
  readonly maxDistinctServicesPerWindow: number;
};

let limits: ThrottleLimits | null = null;

/** Inject the three UNSET limits. Called once at the composition root, and by tests. */
export function configureThrottle(l: ThrottleLimits): void {
  limits = l;
}

/** Read the injected limits. Throws if unset — no silent default. */
export function throttleLimits(): ThrottleLimits {
  if (limits === null) {
    throw new Error(
      'throttle not configured: inject THROTTLE_WINDOW_MINUTES, ' +
        'MAX_REPORTS_PER_IDENTITY and MAX_DISTINCT_SERVICES_PER_WINDOW via ' +
        'configureThrottle() before use; source ships no default.',
    );
  }
  return limits;
}

/** Test/harness helper: clear injected limits so the "unset" path stays testable. */
export function resetThrottle(): void {
  limits = null;
}
