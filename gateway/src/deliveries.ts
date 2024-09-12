import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// The gateway's single-use ledger of PHI deliveries. A row is inserted, under a primary-key
// constraint, *before* PHI leaves the process, so a grant can be delivered at most once by this
// gateway. Consumption facts are append-only (triggers block deletes and edits); only the
// receipt columns move forward as the on-ledger RecordDelivery is confirmed.

export class ReplayError extends Error {
  constructor(readonly accessId: string) {
    super(`access grant ${accessId} was already used`);
    this.name = 'ReplayError';
  }
}

export interface DeliveryRow {
  access_id: string;
  sub: string;
  record_id: string;
  patient_id: string;
  phi_sha256: string;
  consumed_at: string;
  receipt_state: 'pending' | 'recorded' | 'failed';
  receipt_tx: string | null;
  receipt_block: string | null;
  attempts: number;
  last_error: string | null;
}

export class DeliveryStore {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS deliveries (
        access_id     TEXT PRIMARY KEY,
        sub           TEXT NOT NULL,
        record_id     TEXT NOT NULL,
        patient_id    TEXT NOT NULL,
        phi_sha256    TEXT NOT NULL,
        consumed_at   TEXT NOT NULL,
        receipt_state TEXT NOT NULL DEFAULT 'pending' CHECK (receipt_state IN ('pending','recorded','failed')),
        receipt_tx    TEXT,
        receipt_block TEXT,
        attempts      INTEGER NOT NULL DEFAULT 0,
        last_error    TEXT
      );
      CREATE TRIGGER IF NOT EXISTS deliveries_no_delete BEFORE DELETE ON deliveries
        BEGIN SELECT RAISE(ABORT, 'deliveries is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS deliveries_no_rewrite
        BEFORE UPDATE OF access_id, sub, record_id, patient_id, phi_sha256, consumed_at ON deliveries
        BEGIN SELECT RAISE(ABORT, 'delivery facts are immutable'); END;
    `);
  }

  consume(row: { accessId: string; sub: string; recordId: string; patientId: string; phiSha256: string }, now = new Date()): void {
    try {
      this.db
        .prepare(
          `INSERT INTO deliveries (access_id, sub, record_id, patient_id, phi_sha256, consumed_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(row.accessId, row.sub, row.recordId, row.patientId, row.phiSha256, now.toISOString());
    } catch (err) {
      if (err instanceof Error && /UNIQUE|PRIMARY KEY/i.test(err.message)) throw new ReplayError(row.accessId);
      throw err;
    }
  }

  pending(limit = 50): DeliveryRow[] {
    return this.db
      .prepare(`SELECT * FROM deliveries WHERE receipt_state = 'pending' ORDER BY consumed_at LIMIT ?`)
      .all(limit) as unknown as DeliveryRow[];
  }

  markRecorded(accessId: string, tx: string | null, block: string | null): void {
    this.db
      .prepare(`UPDATE deliveries SET receipt_state = 'recorded', receipt_tx = ?, receipt_block = ?, attempts = attempts + 1 WHERE access_id = ?`)
      .run(tx, block, accessId);
  }

  markAttempt(accessId: string, error: string, giveUp: boolean): void {
    this.db
      .prepare(`UPDATE deliveries SET attempts = attempts + 1, last_error = ?, receipt_state = ? WHERE access_id = ?`)
      .run(error.slice(0, 500), giveUp ? 'failed' : 'pending', accessId);
  }

  get(accessId: string): DeliveryRow | undefined {
    return this.db.prepare(`SELECT * FROM deliveries WHERE access_id = ?`).get(accessId) as unknown as DeliveryRow | undefined;
  }

  forPatient(patientId: string): DeliveryRow[] {
    return this.db
      .prepare(`SELECT * FROM deliveries WHERE patient_id = ? ORDER BY consumed_at`)
      .all(patientId) as unknown as DeliveryRow[];
  }

  close(): void {
    this.db.close();
  }
}
