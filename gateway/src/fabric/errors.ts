import { status as GrpcStatus } from '@grpc/grpc-js';
import { CommitFailed, FreshnessTimeout, OrderingUnavailable } from './ledger.js';

export interface HttpError {
  status: number;
  body: { error: string; message: string; details?: string[] };
  retryAfter?: number;
}

const CHAINCODE_CODES: Record<string, number> = {
  ACCESS_DENIED: 403,
  NOT_FOUND: 404,
  INVALID: 400,
  CONFLICT: 409,
  INTEGRITY: 500,
  PHI_UNAVAILABLE: 503,
};

const QUORUM = 'insufficient number of orderers';

function detailMessages(err: unknown): string[] {
  const details = (err as { details?: unknown }).details;
  if (!Array.isArray(details)) return [];
  return details
    .map((d) => (typeof d === 'object' && d && 'message' in d ? String((d as { message: unknown }).message) : ''))
    .filter(Boolean);
}

function chaincodeCode(text: string): { code: string; message: string } | null {
  const m = /(ACCESS_DENIED|NOT_FOUND|INVALID|CONFLICT|INTEGRITY|PHI_UNAVAILABLE): ?(.*)$/s.exec(text);
  return m && m[1] ? { code: m[1], message: (m[2] ?? '').trim() } : null;
}

// toHttpError turns Fabric and gateway failures into the API's error contract:
// ACCESS_DENIED → 403, quorum/ordering/peer unavailability → 503 with Retry-After, and so on.
export function toHttpError(err: unknown): HttpError {
  if (err instanceof FreshnessTimeout) {
    return {
      status: 503,
      retryAfter: 2,
      body: { error: 'STALE_PEER', message: `${err.message}; refusing to serve possibly stale data` },
    };
  }
  if (err instanceof OrderingUnavailable) {
    return { status: 503, retryAfter: 5, body: { error: 'ORDERING_UNAVAILABLE', message: err.message } };
  }
  if (err instanceof CommitFailed) {
    const retryable = err.status === 'MVCC_READ_CONFLICT' || err.status === 'PHANTOM_READ_CONFLICT';
    return {
      status: 409,
      body: {
        error: retryable ? 'READ_CONFLICT' : 'COMMIT_FAILED',
        message: retryable
          ? `state changed while the transaction was in flight (${err.status}); retry`
          : err.message,
      },
    };
  }
  const details = detailMessages(err);
  const text = [err instanceof Error ? err.message : String(err), ...details].join(' | ');
  for (const d of [...details, text]) {
    const cc = chaincodeCode(d);
    if (cc) {
      const status = CHAINCODE_CODES[cc.code] ?? 500;
      return { status, body: { error: cc.code, message: cc.message }, ...(status === 503 ? { retryAfter: 3 } : {}) };
    }
  }
  if (/creator.*(revoked|not valid|expired)|certificate.*revoked|access denied: channel/i.test(text)) {
    return { status: 403, body: { error: 'CERT_REJECTED', message: 'the peer rejected this user\'s certificate', details } };
  }
  const code = (err as { code?: unknown }).code;
  if (text.includes(QUORUM)) {
    return { status: 503, retryAfter: 10, body: { error: 'ORDERING_QUORUM_LOST', message: QUORUM, details } };
  }
  if (code === GrpcStatus.UNAVAILABLE || code === GrpcStatus.DEADLINE_EXCEEDED || code === GrpcStatus.ABORTED) {
    return { status: 503, retryAfter: 5, body: { error: 'FABRIC_UNAVAILABLE', message: text.slice(0, 500), details } };
  }
  return { status: 500, body: { error: 'INTERNAL', message: text.slice(0, 500) } };
}
