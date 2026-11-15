// Scripted flood-control scenarios — SYNTHETIC reports, labelled with the true
// problem each one is about. Not a test file: tests/floodControl.test.ts asserts
// on these, and `npm run eval:flood` prints the same numbers for docs/RESULTS.md.
//
// What the labels let us measure:
//   - creates: tickets actually created (INC + REQ)
//   - naive creates: one ticket per report, what a plain web form would do
//   - duplicate creates avoided: naive creates − creates
//   - false merges: a report linked to a parent opened for a DIFFERENT problem
//   - missed merges: a second INC created for a problem that already had one

import { handleReport } from '../src/orchestrator';
import { buildStage1 } from '../src/composition';
import { CORPUS_NOW } from './corpus';

type ScriptedReport = {
  readonly text: string;
  /** The true problem this report is about. Same label = should share one ticket. */
  readonly problem: string;
  readonly minute: number;
};

export type Scenario = { readonly name: string; readonly reports: readonly ScriptedReport[] };

const NRH_WIFI = 'wifi in North Residence Hall keeps dropping';
const range = (n: number): number[] => [...Array(n).keys()];
const burst = (text: string, problem: string, n: number, startMinute = 0): ScriptedReport[] =>
  range(n).map((i) => ({ text, problem, minute: startMinute + i }));

export const SCENARIOS: readonly Scenario[] = [
  { name: 'one building, 30 reporters', reports: burst(NRH_WIFI, 'nrh-wifi', 30) },
  {
    name: 'same service, two buildings, interleaved',
    reports: range(20).map((i) =>
      i % 2 === 0
        ? { text: NRH_WIFI, problem: 'nrh-wifi', minute: i }
        : { text: 'wifi in Main Library keeps dropping', problem: 'lib-wifi', minute: i },
    ),
  },
  {
    name: 'same building, two services',
    reports: range(20).map((i) =>
      i % 2 === 0
        ? { text: NRH_WIFI, problem: 'nrh-wifi', minute: i }
        : { text: 'the ethernet in North Residence Hall will not connect', problem: 'nrh-wired', minute: i },
    ),
  },
  {
    name: 'classroom AV, two rooms in one building',
    reports: [
      ...burst('The projector in Lecture Hall room 214 will not turn on', 'lect-214', 6),
      ...burst('The projector in Lecture Hall room 101 will not turn on', 'lect-101', 6, 1),
    ],
  },
  {
    name: 'personal reports inside a building flood',
    reports: [
      ...burst(NRH_WIFI, 'nrh-wifi', 10),
      ...range(5).map((i) => ({
        text: "my laptop won't connect to the wifi in my dorm but my roommate's does",
        problem: `personal-${i}`,
        minute: i,
      })),
    ],
  },
  { name: 'campus-wide VPN outage', reports: burst('Nobody can connect to the campus VPN right now', 'vpn-wide', 15) },
  {
    // Known limit, kept on purpose: the link window is fixed from the parent's
    // creation (120 demo minutes), so an outage that outlasts it gets a second INC.
    name: 'one outage outlasting the link window',
    reports: [...burst(NRH_WIFI, 'nrh-wifi', 10), ...burst(NRH_WIFI, 'nrh-wifi', 10, 130)],
  },
];

export type ScenarioResult = {
  readonly name: string;
  readonly reports: number;
  readonly creates: number;
  readonly naiveCreates: number;
  readonly duplicateCreatesAvoided: number;
  readonly falseMerges: number;
  readonly missedMerges: number;
};

/**
 * Runs one scenario through the real stage-1 system (keyword parser, in-memory
 * adapters, flood ledger, example policy), one report per distinct reporter,
 * in time order. canFollowUp is false, as on a one-shot web form, so personal
 * reports file a request instead of asking a question.
 */
export async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  let minute = 0;
  const start = Date.parse(CORPUS_NOW);
  const system = buildStage1({ clock: () => new Date(start + minute * 60_000) });
  const problemOfTicket = new Map<string, string>();
  const incidentsPerProblem = new Map<string, number>();
  let creates = 0;
  let falseMerges = 0;

  const ordered = [...scenario.reports].sort((a, b) => a.minute - b.minute);
  for (const [i, report] of ordered.entries()) {
    minute = report.minute;
    const res = await handleReport(
      { text: report.text, identityRef: `${scenario.name}-reporter-${i}`, canFollowUp: false },
      system.deps,
    );
    if (res.ticket !== undefined) {
      creates++;
      problemOfTicket.set(res.ticket.ticketNumber, report.problem);
      if (res.outcome === 'FILED_INCIDENT') {
        incidentsPerProblem.set(report.problem, (incidentsPerProblem.get(report.problem) ?? 0) + 1);
      }
    }
    const linkedTo = res.outcome === 'MATCHED_CLUSTER' ? res.cluster?.ticketIds[0] : undefined;
    if (linkedTo !== undefined && problemOfTicket.get(linkedTo) !== report.problem) falseMerges++;
  }

  return {
    name: scenario.name,
    reports: ordered.length,
    creates,
    naiveCreates: ordered.length,
    duplicateCreatesAvoided: ordered.length - creates,
    falseMerges,
    missedMerges: [...incidentsPerProblem.values()].reduce((sum, n) => sum + n - 1, 0),
  };
}
