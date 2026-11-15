// The flood ledger — the app's own record of each open parent incident and of
// everyone who reported into it (docs/DECISIONS.md #1).
//
// When many people report the same problem, ServiceNow gets ONE incident (the
// parent, a create). Every later report is a child: it is never created in
// ServiceNow and lives only here, as a reporter hash on the parent. The
// "counter" is the size of that set, so a reporter who reports twice counts
// once. Nothing here can touch ServiceNow; the ledger is local state.
//
// shortcut: in-memory, like the throttle and idempotency stores, so a restart
// mid-flood loses the counts and the next report opens a second parent. Move to
// node:sqlite (as src/analyst/ledger.ts does) before any non-demo deployment.

import type { PriorityDecision } from './contracts/types';
import type { Recommendation } from './priorityPolicy';

export type FloodParent = {
  readonly key: string; // clusterGate.floodKey()
  readonly service: string;
  /** Epoch ms. The link window runs from here and does not slide. */
  readonly openedAt: number;
  /** null while the parent's create timed out with an unknown outcome. */
  readonly ticketNumber: string | null;
  readonly url: string;
  /** Written to the parent at create. Never changed afterwards. */
  readonly priority: PriorityDecision;
  /** Distinct reporter hashes, the parent's own included. `.size` is the counter. */
  readonly reporters: Set<string>;
  /** The subset of `reporters` whose report read as frustrated. */
  readonly frustrated: Set<string>;
  /** At most one pending raise for a human to apply. A further rise replaces it. */
  recommendation: Recommendation | null;
};

export class InMemoryFloodLedger {
  private readonly parents = new Map<string, FloodParent>();
  private readonly queues = new Map<string, Promise<unknown>>();

  /**
   * The parent for this key if it was opened within the window, else null.
   * shortcut: a parent IT closes inside the window still absorbs reports (and
   * the reply says a ticket is open); in ServiceNow mode, count the parent only
   * while it appears in the active=true search result.
   */
  open(key: string, now: Date, windowMinutes: number): FloodParent | null {
    const parent = this.parents.get(key);
    if (parent === undefined || now.getTime() - parent.openedAt > windowMinutes * 60_000) return null;
    return parent;
  }

  /** Records a new parent for its key. An expired parent for the same key is replaced. */
  start(parent: FloodParent): void {
    this.parents.set(parent.key, parent);
  }

  /** Adds one reporter to a parent. The same hash twice still counts once. */
  link(parent: FloodParent, reporterHash: string, frustrated: boolean): void {
    parent.reporters.add(reporterHash);
    if (frustrated) parent.frustrated.add(reporterHash);
  }

  /** Every parent this process has opened (one per key: the latest). */
  all(): FloodParent[] {
    return [...this.parents.values()];
  }

  /**
   * Runs `work` only after every earlier call for the same key has finished.
   * Without this, a concurrent burst would all see "no parent yet" and each
   * create one. Reports for different keys still run in parallel.
   * shortcut: the queue also holds each report's ServiceNow search, so a large
   * real flood queues for minutes; hold it only while no parent exists yet.
   */
  serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const result = previous.then(work);
    // The queue keeps moving even when one request fails.
    const settled = result.catch(() => undefined);
    this.queues.set(key, settled);
    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key);
    });
    return result;
  }
}
