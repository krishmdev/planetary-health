import type { Logger } from 'pino';
import { type DeliveryStore, ReplayError } from './deliveries.js';
import { toHttpError } from './fabric/errors.js';
import type { Ledger, TxReceipt } from './fabric/ledger.js';

export interface AccessGrant {
  accessId: string;
  patientId: string;
  recordId: string;
  recordType: string;
  actor: string;
  basis: string;
  purpose: string;
  status: string;
  createdAt: string;
  expiresAt: string;
}

export interface PhiResponse {
  accessId: string;
  recordId: string;
  patientId: string;
  type: string;
  phi: string;
  phiSha256: string;
  basis: string;
}

export interface Freshness {
  grantBlock: string | null;
  ordererNewest: string;
  waitedForBlock: string;
  waitMs: number;
  enforced: boolean;
}

export interface Delivery {
  record: PhiResponse;
  freshness: Freshness;
  receipt: 'pending' | 'recorded';
}

export interface PhiOptions {
  freshness: boolean;
  freshnessTimeoutMs: number;
}

// PhiService is the only path that releases PHI. Order matters:
//   1. the grant must be VALID on-ledger (RequestAccess, MAJORITY-endorsed) at block Bg;
//   2. the boundary H comes from f+1 orderers; the read peer must commit max(H, Bg) first;
//   3. ReadRecordPHI re-checks the grant and the *current* consent on that peer;
//   4. the grant is consumed locally (unique key) before the bytes are returned;
//   5. a RecordDelivery receipt is submitted, with an outbox for retries.
export class PhiService {
  private grantBlocks = new Map<string, bigint>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private ledger: Ledger,
    private store: DeliveryStore,
    private opts: PhiOptions,
    private log: Logger,
  ) {}

  async grant(user: string, recordId: string, purpose: string): Promise<{ grant: AccessGrant; receipt: TxReceipt }> {
    const { result, receipt } = await this.ledger.submit<AccessGrant>(user, 'RequestAccess', [recordId, purpose]);
    this.grantBlocks.set(result.accessId, BigInt(receipt.blockNumber));
    if (this.grantBlocks.size > 10_000) this.grantBlocks.clear();
    return { grant: result, receipt };
  }

  async deliver(user: string, accessId: string): Promise<Delivery> {
    if (this.store.get(accessId)) throw new ReplayError(accessId);
    const freshness = await this.waitFresh(user, accessId);
    const record = await this.ledger.evaluate<PhiResponse>(user, 'ReadRecordPHI', [accessId], { readPeer: true });
    this.store.consume({
      accessId,
      sub: user,
      recordId: record.recordId,
      patientId: record.patientId,
      phiSha256: record.phiSha256,
    });
    const receipt = await this.sendReceipt(user, accessId).catch(() => 'pending' as const);
    return { record, freshness, receipt };
  }

  async readRecord(user: string, recordId: string, purpose: string): Promise<Delivery & { grant: AccessGrant; grantReceipt: TxReceipt }> {
    const { grant, receipt } = await this.grant(user, recordId, purpose);
    const d = await this.deliver(user, grant.accessId);
    return { ...d, grant, grantReceipt: receipt };
  }

  private async waitFresh(user: string, accessId: string): Promise<Freshness> {
    const t0 = performance.now();
    const newest = await this.ledger.ordererBoundary(user);
    const bg = this.grantBlocks.get(accessId) ?? null;
    const target = bg !== null && bg > newest ? bg : newest;
    if (this.opts.freshness) {
      await this.ledger.waitForPeerBlock(user, target, this.opts.freshnessTimeoutMs, { readPeer: true });
    }
    return {
      grantBlock: bg === null ? null : bg.toString(),
      ordererNewest: newest.toString(),
      waitedForBlock: target.toString(),
      waitMs: Math.round(performance.now() - t0),
      enforced: this.opts.freshness,
    };
  }

  private async sendReceipt(user: string, accessId: string): Promise<'recorded'> {
    try {
      const { receipt } = await this.ledger.submit(user, 'RecordDelivery', [accessId]);
      this.store.markRecorded(accessId, receipt.txId, receipt.blockNumber);
      return 'recorded';
    } catch (err) {
      const e = toHttpError(err);
      if (e.body.error === 'CONFLICT') {
        // Already on the ledger (an earlier attempt landed but we didn't see the ack).
        this.store.markRecorded(accessId, null, null);
        return 'recorded';
      }
      const row = this.store.get(accessId);
      const giveUp = e.status === 403 || e.status === 404 || (row?.attempts ?? 0) >= 20;
      this.store.markAttempt(accessId, `${e.body.error}: ${e.body.message}`, giveUp);
      this.log.warn({ accessId, error: e.body.error }, 'delivery receipt not recorded yet');
      throw err;
    }
  }

  // flushOutbox retries receipts that couldn't be submitted, e.g. while ordering was down.
  async flushOutbox(): Promise<number> {
    let recorded = 0;
    for (const row of this.store.pending()) {
      try {
        await this.sendReceipt(row.sub, row.access_id);
        recorded++;
      } catch {
        // stays pending
      }
    }
    return recorded;
  }

  startOutbox(intervalMs = 5000): void {
    this.timer ??= setInterval(() => {
      this.flushOutbox().catch(() => undefined);
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
