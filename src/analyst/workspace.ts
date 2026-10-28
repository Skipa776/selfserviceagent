import type { ReportEvent } from '../contracts/types';
import type { ProblemReport } from '../contracts/types';
import type { ChatClient } from '../parser/chatClient';
import { ShadowApprovalStore, type ShadowApproval } from './approval';
import { canonicalApprovalDigest } from './approval';
import type { AnalystEvidenceSnapshot, AnalystProposal } from './contracts';
import { buildEvidenceSnapshots } from './evidence';
import { SqliteAnalystLedger, type LocalSharedTicket } from './ledger';
import { createAnalystModel } from './model';

export class AnalystWorkspace {
  private readonly ledger: SqliteAnalystLedger;
  private readonly approvals: ShadowApprovalStore;
  private readonly proposals = new Map<string, AnalystProposal>();

  constructor(
    path: string,
    private readonly client: ChatClient,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.ledger = new SqliteAnalystLedger(path);
    this.approvals = new ShadowApprovalStore(clock, this.ledger.approvals());
  }

  ingest(events: readonly ReportEvent[]): void {
    for (const event of events) this.ledger.append(event);
  }

  snapshots(): AnalystEvidenceSnapshot[] {
    return buildEvidenceSnapshots(this.ledger.list(), this.clock().toISOString());
  }

  async generate(snapshotId: string): Promise<
    { ok: true; value: AnalystProposal; digest: string } | { ok: false; error: string }
  > {
    const snapshot = this.snapshots().find((candidate) => candidate.snapshotId === snapshotId);
    if (snapshot === undefined) return { ok: false, error: 'snapshot_not_found' };
    const result = await createAnalystModel(this.client).propose(snapshot);
    if (!result.ok) return result;
    this.proposals.set(snapshotId, result.value);
    this.ledger.saveProposal(result.value);
    return { ...result, digest: canonicalApprovalDigest(result.value) };
  }

  proposal(snapshotId: string): AnalystProposal | null {
    const proposal = this.proposals.get(snapshotId) ?? this.ledger.proposal(snapshotId);
    if (proposal !== null) this.proposals.set(snapshotId, proposal);
    return proposal;
  }

  proposalDigest(snapshotId: string): string | null {
    const proposal = this.proposals.get(snapshotId);
    return proposal === undefined ? null : canonicalApprovalDigest(proposal);
  }

  approve(snapshotId: string, expectedDigest: string, approver: string):
    { ok: true; value: ShadowApproval; sharedTicket: LocalSharedTicket } | { ok: false; error: string } {
    const proposal = this.proposal(snapshotId);
    if (proposal === null) return { ok: false, error: 'proposal_not_found' };
    if (canonicalApprovalDigest(proposal) !== expectedDigest) return { ok: false, error: 'proposal_changed' };
    if (!this.snapshots().some((snapshot) => snapshot.snapshotId === snapshotId)) {
      return { ok: false, error: 'snapshot_stale' };
    }
    const approval = this.approvals.approve(proposal, approver);
    this.ledger.saveApproval(approval);
    const snapshot = this.snapshots().find((candidate) => candidate.snapshotId === snapshotId);
    if (snapshot === undefined) return { ok: false, error: 'snapshot_stale' };
    const existing = this.ledger.sharedTickets().find((ticket) => ticket.topicKey === snapshot.topicKey);
    const sharedTicket: LocalSharedTicket = existing ?? {
      mode: 'local-demo',
      ticketNumber: `SHARED-DEMO-${String(this.ledger.sharedTickets().length + 1).padStart(4, '0')}`,
      topicKey: snapshot.topicKey,
      snapshotId,
      shortDescription: proposal.shortDescription,
      description: proposal.description,
      impact: proposal.recommendedImpact,
      urgency: proposal.recommendedUrgency,
      createdAt: this.clock().toISOString(),
    };
    this.ledger.saveSharedTicket(sharedTicket);
    return { ok: true, value: approval, sharedTicket };
  }

  sharedTickets(): LocalSharedTicket[] {
    return this.ledger.sharedTickets();
  }

  matchSharedTicket(report: ProblemReport): LocalSharedTicket | null {
    const room = report.service === 'classroom_av' ? report.room : '';
    const key = [report.service, report.scope, report.building, room, report.symptom].join('|');
    return this.sharedTickets().find((ticket) => ticket.topicKey === key) ?? null;
  }

  status(): { mode: 'shadow'; serviceNowCreationEnabled: false; approvals: number } {
    return { mode: 'shadow', serviceNowCreationEnabled: false, approvals: this.approvals.records.length };
  }

  close(): void {
    this.ledger.close();
  }
}
