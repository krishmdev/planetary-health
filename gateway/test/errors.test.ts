import { status } from '@grpc/grpc-js';
import { describe, expect, it } from 'vitest';
import { toHttpError } from '../src/fabric/errors.js';
import { CommitFailed, FreshnessTimeout, OrderingUnavailable } from '../src/fabric/ledger.js';

const withDetail = (msg: string, code: number = status.UNKNOWN) =>
  Object.assign(new Error('failed to endorse transaction, see attached details for more info'), {
    code,
    details: [{ address: 'peer0.org1.example.com:7051', mspId: 'Org1MSP', message: msg }],
  });

describe('toHttpError', () => {
  it.each([
    ['chaincode response 500, ACCESS_DENIED: patients can only access their own records', 403, 'ACCESS_DENIED'],
    ['chaincode response 500, NOT_FOUND: record R-1', 404, 'NOT_FOUND'],
    ['chaincode response 500, INVALID: purpose is required', 400, 'INVALID'],
    ['chaincode response 500, CONFLICT: consent C-1 is already revoked', 409, 'CONFLICT'],
    ['chaincode response 500, INTEGRITY: private data for R-1 does not match', 500, 'INTEGRITY'],
  ])('maps %s', (msg, code, name) => {
    const e = toHttpError(withDetail(msg));
    expect(e.status).toBe(code);
    expect(e.body.error).toBe(name);
    expect(e.body.message).not.toContain('chaincode response');
  });

  it('maps the BFT quorum error to 503 with Retry-After', () => {
    const e = toHttpError(
      Object.assign(new Error('insufficient number of orderers could successfully process transaction to satisfy quorum requirement'), {
        code: status.UNAVAILABLE,
      }),
    );
    expect(e.status).toBe(503);
    expect(e.body.error).toBe('ORDERING_QUORUM_LOST');
    expect(e.retryAfter).toBeGreaterThan(0);
  });

  it('maps unavailable peers and timeouts to 503', () => {
    expect(toHttpError(Object.assign(new Error('connect failed'), { code: status.UNAVAILABLE })).status).toBe(503);
    expect(toHttpError(Object.assign(new Error('deadline'), { code: status.DEADLINE_EXCEEDED })).status).toBe(503);
  });

  it('maps freshness and ordering failures to 503', () => {
    const f = toHttpError(new FreshnessTimeout(12n, 5000));
    expect(f.status).toBe(503);
    expect(f.body.error).toBe('STALE_PEER');
    expect(toHttpError(new OrderingUnavailable('only 1 of 2')).body.error).toBe('ORDERING_UNAVAILABLE');
  });

  it('maps MVCC conflicts to a retryable 409', () => {
    const e = toHttpError(new CommitFailed('tx1', 'MVCC_READ_CONFLICT', '7'));
    expect(e.status).toBe(409);
    expect(e.body.error).toBe('READ_CONFLICT');
    expect(toHttpError(new CommitFailed('tx1', 'ENDORSEMENT_POLICY_FAILURE', '7')).body.error).toBe('COMMIT_FAILED');
  });

  it('maps a revoked certificate to 403', () => {
    const e = toHttpError(withDetail('error validating proposal: access denied: channel [ehrchannel] creator org unknown, creator is malformed'));
    expect(e.status).toBe(403);
    const r = toHttpError(withDetail('failed evaluating policy: the supplied identity is not valid: x509: certificate is revoked'));
    expect(r.status).toBe(403);
  });

  it('falls back to 500', () => {
    expect(toHttpError(new Error('something odd')).status).toBe(500);
  });
});
