import { createHash } from 'node:crypto';

import type { AnalystProposal } from './contracts';

export type ShadowApproval = {
  readonly mode: 'shadow';
  readonly snapshotId: string;
  readonly payloadDigest: string;
  readonly approver: string;
  readonly approvedAt: string;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalApprovalDigest(proposal: AnalystProposal): string {
  return createHash('sha256').update(canonical(proposal)).digest('hex');
}

export class ShadowApprovalStore {
  readonly records: ShadowApproval[];

  constructor(private readonly clock: () => Date, initial: readonly ShadowApproval[] = []) {
    this.records = [...initial];
  }

  approve(proposal: AnalystProposal, approver: string): ShadowApproval {
    const payloadDigest = canonicalApprovalDigest(proposal);
    const existing = this.records.find((record) => record.payloadDigest === payloadDigest && record.approver === approver);
    if (existing !== undefined) return existing;
    const approval: ShadowApproval = {
      mode: 'shadow',
      snapshotId: proposal.snapshotId,
      payloadDigest,
      approver,
      approvedAt: this.clock().toISOString(),
    };
    this.records.push(approval);
    return approval;
  }
}
