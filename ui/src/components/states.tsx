import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { ApiError, isUnreachable, reachability, type Receipt } from '../api';

export function Loading({ rows = 3, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <span className="sr-only">{label}…</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ width: `${90 - i * 18}%` }} />
      ))}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state center">
      <span className="glyph" aria-hidden>
        ∅
      </span>
      <strong>{title}</strong>
      {children && <p className="muted small">{children}</p>}
    </div>
  );
}

// Plain-language explanations for the gateway's error codes.
function explain(e: ApiError): { title: string; hint: string; kind: 'error' | 'unavailable' } {
  if (e.status === 403) {
    const cert = e.code === 'CERT_REJECTED';
    return {
      kind: 'error',
      title: cert ? 'Certificate rejected by the network' : 'Access denied by the access policy',
      hint: cert
        ? 'Your certificate has been revoked. Ask your hospital administrator.'
        : 'Both hospitals checked the policy against your certificate. You need the patient’s consent, or emergency access.',
    };
  }
  if (isUnreachable(e)) return { kind: 'unavailable', title: 'Gateway unreachable', hint: 'The hospital API is not answering. It may be waking up, or the stack may be down.' };
  if (e.status === 503) {
    const stale = e.code === 'STALE_PEER';
    const quorum = e.code === 'ORDERING_QUORUM_LOST';
    return {
      kind: 'unavailable',
      title: stale ? 'Waiting for the ledger to catch up' : quorum ? 'Ordering service lost quorum' : 'The network is temporarily unavailable',
      hint: stale
        ? 'This hospital’s peer is behind the ordering service, so nothing was shown rather than something possibly out of date.'
        : quorum
          ? 'Fewer than 3 of 4 orderers are reachable, so no transaction can commit.'
          : 'A service is waking up or unreachable.',
    };
  }
  if (e.status === 409) return { kind: 'error', title: 'Already used or changed', hint: 'This grant was used already, or the data changed while the request was in flight.' };
  if (e.status === 404) return { kind: 'error', title: 'Not found', hint: 'It may have been purged, or the ID is wrong.' };
  if (isUnreachable(e)) return { kind: 'unavailable', title: 'Gateway unreachable', hint: 'The hospital API is not answering. It may be waking up, or the stack may be down.' };
  return { kind: 'error', title: 'Something went wrong', hint: 'Try again. If it keeps happening, check the gateway logs.' };
}

export function useUnreachable(): boolean {
  const [n, setN] = useState(reachability.failures);
  useEffect(() => {
    const off = reachability.subscribe(setN);
    return () => {
      off();
    };
  }, []);
  return n >= 2;
}

// Errors from background queries are announced politely (role=status); errors after something
// the user just did use role=alert.
export function ErrorState({ error, onRetry, afterAction = false }: { error: unknown; onRetry?: () => void; afterAction?: boolean }) {
  const e = error instanceof ApiError ? error : new ApiError(500, 'CLIENT', String((error as Error)?.message ?? error), null);
  const x = explain(e);
  const banner = useUnreachable();
  // Retrying won't change a policy decision or an already-used grant.
  const retry = e.status === 403 || e.status === 409 ? undefined : onRetry;
  if (banner && isUnreachable(e) && !afterAction) {
    return (
      <p className="state muted small" role="status">
        Unavailable while the gateway is unreachable.
      </p>
    );
  }
  return (
    <div className={`state ${x.kind}`} role={afterAction ? 'alert' : 'status'}>
      <strong>
        {x.title} <span className="mono xs muted">{e.status || ''} {e.code}</span>
      </strong>
      <p className="small">{x.hint}</p>
      {e.message && <p className="xs mono muted">{e.message}</p>}
      <div className="row">
        {e.retryAfter !== null && <span className="xs muted">Retry after {e.retryAfter}s.</span>}
        {retry && (
          <button type="button" className="ghost" onClick={retry}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

export function TxReceipt({ receipt, label }: { receipt: Receipt; label: string }) {
  return (
    <div className="receipt" aria-label="Transaction receipt">
      <span>
        <b>{receipt.status}</b> · {label}
      </span>
      <span>block #{receipt.blockNumber}</span>
      <span title={receipt.txId}>tx {receipt.txId.slice(0, 20)}…</span>
      <span className="muted">endorsed by Org1MSP + Org2MSP (MAJORITY)</span>
    </div>
  );
}

export function when(ts: string | undefined): string {
  if (!ts) return '';
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function until(ts: string): string {
  const ms = new Date(ts).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min left`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h left`;
  return `${Math.round(h / 24)} days left`;
}
