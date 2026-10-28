import { DatabaseSync } from 'node:sqlite';

import type { ReportEvent } from '../contracts/types';
import type { AnalystProposal } from './contracts';
import type { ShadowApproval } from './approval';

export type LocalSharedTicket = {
  readonly mode: 'local-demo';
  readonly ticketNumber: string;
  readonly topicKey: string;
  readonly snapshotId: string;
  readonly shortDescription: string;
  readonly description: string;
  readonly impact: string;
  readonly urgency: string;
  readonly createdAt: string;
};

export class SqliteAnalystLedger {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS analyst_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        correlation_id TEXT NOT NULL UNIQUE,
        event_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS analyst_proposals (
        snapshot_id TEXT PRIMARY KEY,
        proposal_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS analyst_approvals (
        payload_digest TEXT PRIMARY KEY,
        approval_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS analyst_shared_tickets (
        topic_key TEXT PRIMARY KEY,
        ticket_json TEXT NOT NULL
      ) STRICT;
    `);
  }

  append(event: ReportEvent): number {
    const encoded = JSON.stringify(event);
    const existing = this.db.prepare(
      'SELECT sequence, event_json FROM analyst_events WHERE correlation_id = ?',
    ).get(event.correlationId) as { sequence: number; event_json: string } | undefined;
    if (existing !== undefined) {
      if (existing.event_json !== encoded) throw new Error(`conflicting analyst event ${event.correlationId}`);
      return existing.sequence;
    }
    const inserted = this.db.prepare(
      'INSERT INTO analyst_events (correlation_id, event_json) VALUES (?, ?)',
    ).run(event.correlationId, encoded);
    return Number(inserted.lastInsertRowid);
  }

  list(): ReportEvent[] {
    const rows = this.db.prepare('SELECT event_json FROM analyst_events ORDER BY sequence').all() as Array<{ event_json: string }>;
    return rows.map((row) => JSON.parse(row.event_json) as ReportEvent);
  }

  watermark(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS value FROM analyst_events').get() as { value: number };
    return row.value;
  }

  saveProposal(proposal: AnalystProposal): void {
    this.db.prepare(
      'INSERT INTO analyst_proposals (snapshot_id, proposal_json) VALUES (?, ?) ON CONFLICT(snapshot_id) DO UPDATE SET proposal_json=excluded.proposal_json',
    ).run(proposal.snapshotId, JSON.stringify(proposal));
  }

  proposal(snapshotId: string): AnalystProposal | null {
    const row = this.db.prepare('SELECT proposal_json FROM analyst_proposals WHERE snapshot_id = ?').get(snapshotId) as { proposal_json: string } | undefined;
    return row === undefined ? null : JSON.parse(row.proposal_json) as AnalystProposal;
  }

  saveApproval(approval: ShadowApproval): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO analyst_approvals (payload_digest, approval_json) VALUES (?, ?)',
    ).run(approval.payloadDigest, JSON.stringify(approval));
  }

  approvals(): ShadowApproval[] {
    const rows = this.db.prepare('SELECT approval_json FROM analyst_approvals ORDER BY rowid').all() as Array<{ approval_json: string }>;
    return rows.map((row) => JSON.parse(row.approval_json) as ShadowApproval);
  }

  saveSharedTicket(ticket: LocalSharedTicket): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO analyst_shared_tickets (topic_key, ticket_json) VALUES (?, ?)',
    ).run(ticket.topicKey, JSON.stringify(ticket));
  }

  sharedTickets(): LocalSharedTicket[] {
    const rows = this.db.prepare('SELECT ticket_json FROM analyst_shared_tickets ORDER BY rowid').all() as Array<{ ticket_json: string }>;
    return rows.map((row) => JSON.parse(row.ticket_json) as LocalSharedTicket);
  }

  close(): void {
    this.db.close();
  }
}
