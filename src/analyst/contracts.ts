import type { DecideOutcome } from '../contracts/types';

export const IMPACT_VALUES = ['1', '2', '3'] as const;
export const URGENCY_VALUES = ['1', '2', '3'] as const;
export const EVIDENCE_STRENGTHS = ['insufficient', 'limited', 'sufficient'] as const;

export type AnalystEvidence = {
  readonly id: string;
  readonly correlationId: string;
  readonly reporterHash: string;
  readonly outcome: DecideOutcome;
  readonly ticketNumber: string;
  readonly viaOverride: boolean;
  readonly ts: string;
};

export type AnalystEvidenceSnapshot = {
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly topicKey: string;
  readonly service: string;
  readonly scope: string;
  readonly location: string;
  readonly building: string;
  readonly room: string;
  readonly symptom: string;
  readonly firstReportAt: string;
  readonly lastReportAt: string;
  readonly filedDistinct: number;
  readonly overflowDistinct: number;
  readonly overrideDistinct: number;
  readonly totalDistinct: number;
  readonly filedTicketNumbers: readonly string[];
  readonly evidence: readonly AnalystEvidence[];
};

export type AnalystProposal = {
  readonly snapshotId: string;
  readonly shortDescription: string;
  readonly description: string;
  readonly recommendedImpact: (typeof IMPACT_VALUES)[number];
  readonly recommendedUrgency: (typeof URGENCY_VALUES)[number];
  readonly evidenceStrength: (typeof EVIDENCE_STRENGTHS)[number];
  readonly rationale: string;
  readonly citations: readonly {
    readonly claim: string;
    readonly evidenceIds: readonly string[];
  }[];
  readonly splitRecommendation: {
    readonly shouldSplit: boolean;
    readonly evidenceIds: readonly string[];
    readonly rationale: string;
  };
};
