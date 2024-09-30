import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, type Delivery, type RecordMeta } from '../api';
import { useSession } from '../session';
import { Empty, ErrorState, Loading, when } from './states';

function PhiView({ phi }: { phi: string }) {
  let parsed: Record<string, unknown> | null = null;
  try {
    const v = JSON.parse(phi);
    if (v && typeof v === 'object') parsed = v as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  if (!parsed) return <p>{phi}</p>;
  return (
    <dl>
      {Object.entries(parsed).map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function RecordRow({ r, canRead, onEmergency }: { r: RecordMeta; canRead: boolean; onEmergency?: (pid: string) => void }) {
  const { api } = useSession();
  const [purpose, setPurpose] = useState('treatment');
  const read = useMutation({ mutationFn: () => api<Delivery>('POST', `/records/${r.recordId}/read`, { purpose }) });
  const denied = read.error instanceof ApiError && read.error.status === 403;
  return (
    <div className="record">
      <span className="type">{r.type}</span>
      <div>
        <div className="spread">
          <span className="mono small">{r.recordId}</span>
          <span className="muted xs">
            {when(r.createdAt)} · by {r.createdBy} ({r.org})
          </span>
        </div>
        <p className="xs muted mono" title="SHA-256 of the PHI, stored on the public ledger">
          sha256 {r.phiSha256.slice(0, 24)}…
        </p>
        {r.purged && <span className="tag warn">PHI purged, digest kept</span>}
        {read.isPending && <Loading rows={2} label="Requesting access" />}
        {read.error && <ErrorState error={read.error} onRetry={() => read.mutate()} afterAction />}
        {denied && onEmergency && (
          <p className="small" style={{ marginTop: 8 }}>
            In an emergency without consent,{' '}
            <button type="button" className="link" onClick={() => onEmergency(r.patientId)}>
              request emergency access for {r.patientId}
            </button>
            .
          </p>
        )}
        {read.data && (
          <div className="phi" aria-live="polite">
            <PhiView phi={read.data.record.phi} />
            <p className="xs muted" style={{ marginTop: 8 }}>
              Basis <span className="mono">{read.data.record.basis}</span> · grant <span className="mono">{read.data.grant.accessId}</span> in block #
              {read.data.grantReceipt.blockNumber} · peer caught up to block #{read.data.freshness.waitedForBlock} ({read.data.freshness.waitMs} ms) · receipt{' '}
              {read.data.receipt}
            </p>
          </div>
        )}
      </div>
      {canRead && !r.purged && !read.data && !denied && (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <label className="sr-only" htmlFor={`p-${r.recordId}`}>
            Purpose
          </label>
          <select id={`p-${r.recordId}`} className="compact" value={purpose} onChange={(e) => setPurpose(e.target.value)}>
            <option value="treatment">Treatment</option>
            <option value="second opinion">Second opinion</option>
            <option value="personal copy">Personal copy</option>
          </select>
          <button type="button" onClick={() => read.mutate()} disabled={read.isPending}>
            Open
          </button>
        </div>
      )}
    </div>
  );
}

export function Records({ patientId, canRead = true, onEmergency }: { patientId: string; canRead?: boolean; onEmergency?: (pid: string) => void }) {
  const { api } = useSession();
  const q = useQuery({ queryKey: ['records', patientId], queryFn: () => api<RecordMeta[]>('GET', `/patients/${patientId}/records`) });
  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (q.data.length === 0) return <Empty title="No records yet">Records appear here once a clinician with consent adds one.</Empty>;
  return (
    <div className="records">
      {q.data.map((r) => (
        <RecordRow key={r.recordId} r={r} canRead={canRead} onEmergency={onEmergency} />
      ))}
    </div>
  );
}
