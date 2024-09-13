import { status } from '@grpc/grpc-js';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { harness, type ScriptedLedger } from './fakes.js';

function chaincodeError(msg: string) {
  return Object.assign(new Error('evaluate call to endorser returned error'), {
    code: status.UNKNOWN,
    details: [{ address: 'peer0.org1.example.com:7051', mspId: 'Org1MSP', message: `chaincode response 500, ${msg}` }],
  });
}

// A small model of the chaincode's grant rules, enough to drive the gateway's delivery path.
function grantModel(ledger: ScriptedLedger) {
  const state = { consent: true, grants: new Map<string, { actor: string; expired: boolean; delivered: boolean }>(), n: 0 };
  ledger
    .on('RequestAccess', (user, [rid]) => {
      if (!state.consent) throw chaincodeError('ACCESS_DENIED: no active consent or emergency access for this record');
      const accessId = `A-${++state.n}`;
      state.grants.set(accessId, { actor: user, expired: false, delivered: false });
      return { accessId, patientId: 'P-1001', recordId: rid, recordType: 'lab', actor: user, basis: 'consent:C-1', status: 'granted' };
    })
    .on('ReadRecordPHI', (user, [accessId]) => {
      const g = state.grants.get(accessId!);
      if (!g) throw chaincodeError(`NOT_FOUND: access grant ${accessId}`);
      if (g.actor !== user) throw chaincodeError(`ACCESS_DENIED: access grant ${accessId} was issued to another user`);
      if (g.expired) throw chaincodeError(`ACCESS_DENIED: access grant ${accessId} expired`);
      if (!state.consent) throw chaincodeError('ACCESS_DENIED: no active consent or emergency access for this record');
      return { accessId, recordId: 'R-1', patientId: 'P-1001', type: 'lab', phi: '{"hba1c":"6.1%"}', phiSha256: 'ab'.repeat(32), basis: 'consent:C-1' };
    })
    .on('RecordDelivery', (_user, [accessId]) => {
      const g = state.grants.get(accessId!)!;
      if (g.delivered) throw chaincodeError(`CONFLICT: delivery for ${accessId} already recorded`);
      g.delivered = true;
      return { accessId, status: 'delivered' };
    })
    .on('AuditReconcile', () => ({
      patientId: 'P-1001',
      grants: [...state.grants.entries()].map(([accessId, g]) => ({ accessId, status: g.delivered ? 'delivered' : 'granted' })),
    }));
  return state;
}

describe('PHI grant and delivery', () => {
  it('delivers once, then rejects replay of the same accessId with 409', async () => {
    const h = await harness();
    grantModel(h.ledger);
    const auth = { Authorization: `Bearer ${await h.token('drchen', 'doctor', 'D-2001')}` };

    const g = await request(h.app).post('/records/R-1/access').set(auth).send({ purpose: 'follow-up' });
    expect(g.status).toBe(200);
    const accessId = g.body.grant.accessId as string;

    const first = await request(h.app).post(`/access/${accessId}/deliver`).set(auth);
    expect(first.status).toBe(200);
    expect(first.body.record.phi).toContain('hba1c');
    expect(first.body.receipt).toBe('recorded');
    expect(h.deliveries.get(accessId)?.receipt_state).toBe('recorded');

    const replay = await request(h.app).post(`/access/${accessId}/deliver`).set(auth);
    expect(replay.status).toBe(409);
    expect(replay.body.error).toBe('GRANT_ALREADY_USED');
  });

  it('only one of two concurrent deliveries of a grant succeeds', async () => {
    const h = await harness();
    grantModel(h.ledger);
    const auth = { Authorization: `Bearer ${await h.token('drchen', 'doctor', 'D-2001')}` };
    const g = await request(h.app).post('/records/R-1/access').set(auth).send({ purpose: 'follow-up' });
    const id = g.body.grant.accessId as string;
    const [a, b] = await Promise.all([
      request(h.app).post(`/access/${id}/deliver`).set(auth),
      request(h.app).post(`/access/${id}/deliver`).set(auth),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it('denies delivery when consent is revoked between grant and read, and consumes nothing', async () => {
    const h = await harness();
    const state = grantModel(h.ledger);
    const auth = { Authorization: `Bearer ${await h.token('drchen', 'doctor', 'D-2001')}` };
    const g = await request(h.app).post('/records/R-1/access').set(auth).send({ purpose: 'follow-up' });
    state.consent = false;
    const r = await request(h.app).post(`/access/${g.body.grant.accessId}/deliver`).set(auth);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('ACCESS_DENIED');
    expect(h.deliveries.get(g.body.grant.accessId)).toBeUndefined();
  });

  it('denies an expired grant and a grant used by a different user', async () => {
    const h = await harness();
    const state = grantModel(h.ledger);
    const chen = { Authorization: `Bearer ${await h.token('drchen', 'doctor', 'D-2001')}` };
    const alice = { Authorization: `Bearer ${await h.token('alice', 'patient', 'P-1001')}` };
    const g = await request(h.app).post('/records/R-1/access').set(chen).send({ purpose: 'follow-up' });
    const id = g.body.grant.accessId as string;

    const other = await request(h.app).post(`/access/${id}/deliver`).set(alice);
    expect(other.status).toBe(403);

    state.grants.get(id)!.expired = true;
    const late = await request(h.app).post(`/access/${id}/deliver`).set(chen);
    expect(late.status).toBe(403);
    expect(late.body.message).toContain('expired');
  });

  it('waits for the read peer to reach the orderer boundary before evaluating', async () => {
    const h = await harness({ timeoutMs: 1000 });
    grantModel(h.ledger);
    const auth = { Authorization: `Bearer ${await h.token('drchen', 'doctor', 'D-2001')}` };
    const g = await request(h.app).post('/records/R-1/access').set(auth).send({ purpose: 'follow-up' });
    const grantBlock = BigInt(g.body.receipt.blockNumber);
    h.ledger.boundary = grantBlock + 3n; // e.g. a revocation was ordered after the grant
    h.ledger.peerHeight = grantBlock + 1n; // but the read peer only has the grant's block
    h.ledger.catchUpAfterMs = 100;

    const r = await request(h.app).post(`/access/${g.body.grant.accessId}/deliver`).set(auth);
    expect(r.status).toBe(200);
    expect(h.ledger.waitedFor.at(-1)).toBe(grantBlock + 3n);
    expect(r.body.freshness.waitedForBlock).toBe((grantBlock + 3n).toString());
    const evalIdx = h.ledger.calls.findIndex((c) => c.fn === 'ReadRecordPHI');
    expect(h.ledger.calls[evalIdx]?.readPeer).toBe(true);
  });

  it('returns 503 with Retry-After, never a stale read, when the peer does not catch up in time', async () => {
    const h = await harness({ timeoutMs: 100 });
    grantModel(h.ledger);
    const auth = { Authorization: `Bearer ${await h.token('drchen', 'doctor', 'D-2001')}` };
    const g = await request(h.app).post('/records/R-1/access').set(auth).send({ purpose: 'follow-up' });
    h.ledger.boundary = BigInt(g.body.receipt.blockNumber) + 5n;
    h.ledger.catchUpAfterMs = null;

    const r = await request(h.app).post(`/access/${g.body.grant.accessId}/deliver`).set(auth);
    expect(r.status).toBe(503);
    expect(r.headers['retry-after']).toBeDefined();
    expect(r.body.error).toBe('STALE_PEER');
    expect(h.ledger.calls.some((c) => c.fn === 'ReadRecordPHI')).toBe(false);
    expect(h.deliveries.get(g.body.grant.accessId)).toBeUndefined();
  });

  it('waits for the grant block even if the orderer answer is lower', async () => {
    const h = await harness({ timeoutMs: 1000 });
    grantModel(h.ledger);
    const auth = { Authorization: `Bearer ${await h.token('drchen', 'doctor', 'D-2001')}` };
    const g = await request(h.app).post('/records/R-1/access').set(auth).send({ purpose: 'x-ray' });
    h.ledger.boundary = 1n;
    const r = await request(h.app).post(`/access/${g.body.grant.accessId}/deliver`).set(auth);
    expect(r.status).toBe(200);
    expect(h.ledger.waitedFor.at(-1)).toBe(BigInt(g.body.receipt.blockNumber));
  });

  it('keeps the receipt in the outbox while ordering is down, then records it', async () => {
    const h = await harness();
    grantModel(h.ledger);
    const auth = { Authorization: `Bearer ${await h.token('drchen', 'doctor', 'D-2001')}` };
    const g = await request(h.app).post('/records/R-1/access').set(auth).send({ purpose: 'follow-up' });
    const id = g.body.grant.accessId as string;
    h.ledger.submitFailure = (fn) =>
      fn === 'RecordDelivery'
        ? Object.assign(new Error('insufficient number of orderers could successfully process transaction to satisfy quorum requirement'), {
            code: status.UNAVAILABLE,
          })
        : null;

    const r = await request(h.app).post(`/access/${id}/deliver`).set(auth);
    expect(r.status).toBe(200);
    expect(r.body.receipt).toBe('pending');
    expect(h.deliveries.get(id)?.receipt_state).toBe('pending');

    const alice = { Authorization: `Bearer ${await h.token('alice', 'patient', 'P-1001')}` };
    const rec = await request(h.app).get('/audit/P-1001/reconcile').set(alice);
    expect(rec.status).toBe(200);
    expect(rec.body.missingReceipts).toHaveLength(1);
    expect(rec.body.missingReceipts[0].accessId).toBe(id);

    h.ledger.submitFailure = null;
    expect(await h.phi.flushOutbox()).toBe(1);
    expect(h.deliveries.get(id)?.receipt_state).toBe('recorded');
    const after = await request(h.app).get('/audit/P-1001/reconcile').set(alice);
    expect(after.body.missingReceipts).toHaveLength(0);
  });

  it('treats an already-recorded receipt as success', async () => {
    const h = await harness();
    const state = grantModel(h.ledger);
    const auth = { Authorization: `Bearer ${await h.token('drchen', 'doctor', 'D-2001')}` };
    const g = await request(h.app).post('/records/R-1/access').set(auth).send({ purpose: 'follow-up' });
    const id = g.body.grant.accessId as string;
    state.grants.get(id)!.delivered = false;
    h.ledger.submitFailure = (fn) => (fn === 'RecordDelivery' ? new Error('timeout') : null);
    await request(h.app).post(`/access/${id}/deliver`).set(auth);
    state.grants.get(id)!.delivered = true; // the earlier attempt actually landed
    h.ledger.submitFailure = null;
    await h.phi.flushOutbox();
    expect(h.deliveries.get(id)?.receipt_state).toBe('recorded');
  });

  it('skips the wait only when freshness is explicitly disabled', async () => {
    const h = await harness({ freshness: false });
    grantModel(h.ledger);
    const auth = { Authorization: `Bearer ${await h.token('drchen', 'doctor', 'D-2001')}` };
    h.ledger.boundary = 999n;
    const r = await request(h.app).post('/records/R-1/read').set(auth).send({ purpose: 'follow-up' });
    expect(r.status).toBe(200);
    expect(r.body.freshness.enforced).toBe(false);
    expect(h.ledger.waitedFor).toHaveLength(0);
  });
});
