import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccessGrant, BreakGlass } from '../api';
import { useSession } from '../session';
import { Empty, ErrorState, Loading, when } from './states';

type Entry = { kind: 'grant'; at: string; g: AccessGrant } | { kind: 'emergency'; at: string; b: BreakGlass };

function basisLabel(b: string): string {
  if (b === 'self') return 'your own request';
  if (b.startsWith('consent:')) return `your consent ${b.slice(8)}`;
  if (b.startsWith('breakglass:')) return `emergency access ${b.slice(11)}`;
  return b;
}

// Who asked for which record, why, on what basis, and whether PHI was actually delivered.
export function AccessLog({ patientId, allowRevoke }: { patientId: string; allowRevoke?: boolean }) {
  const { api } = useSession();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['audit', patientId],
    queryFn: () => api<{ grants: AccessGrant[]; emergency: BreakGlass[] }>('GET', `/audit/${patientId}`),
  });
  const revokeAll = useMutation({
    mutationFn: () => api<{ result: AccessGrant[] }>('POST', '/access-grants/revoke'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['audit', patientId] }),
  });
  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const entries: Entry[] = [
    ...q.data.grants.map((g) => ({ kind: 'grant' as const, at: g.createdAt, g })),
    ...q.data.emergency.map((b) => ({ kind: 'emergency' as const, at: b.createdAt, b })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const outstanding = q.data.grants.filter((g) => g.status === 'granted' && new Date(g.expiresAt) > new Date()).length;
  return (
    <>
      {allowRevoke && outstanding > 0 && (
        <div className="body">
          <div className="banner amber spread">
            <span>
              {outstanding} unused access grant{outstanding > 1 ? 's' : ''} still open (each lasts 5 minutes).
            </span>
            <button type="button" className="ghost" onClick={() => revokeAll.mutate()} disabled={revokeAll.isPending}>
              Cancel them
            </button>
          </div>
          {revokeAll.error && <ErrorState error={revokeAll.error} />}
        </div>
      )}
      {entries.length === 0 ? (
        <Empty title="Nobody has accessed these records">Every request to read PHI is recorded here, endorsed by both hospitals.</Empty>
      ) : (
        <ol className="timeline">
          {entries.slice(0, 30).map((e) =>
            e.kind === 'grant' ? (
              <li key={e.g.accessId}>
                <div className="spread">
                  <strong>
                    {e.g.actor} <span className="muted small">({e.g.actorOrg === 'Org1MSP' ? 'Mercy General' : 'Riverside Clinic'})</span>
                  </strong>
                  <span className="xs muted">{when(e.g.createdAt)}</span>
                </div>
                <p className="small">
                  {e.g.recordType} record <span className="mono">{e.g.recordId}</span> for “{e.g.purpose}”, via {basisLabel(e.g.basis)}
                </p>
                <span className={`tag ${e.g.status === 'delivered' ? 'ok' : e.g.status === 'revoked' ? 'bad' : ''}`}>
                  {e.g.status === 'delivered' ? `viewed ${when(e.g.deliveredAt)}` : e.g.status === 'revoked' ? 'cancelled' : 'granted, not viewed'}
                </span>
              </li>
            ) : (
              <li key={e.b.grantId} className="emergency">
                <div className="spread">
                  <strong>Emergency access by {e.b.providerId}</strong>
                  <span className="xs muted">{when(e.b.createdAt)}</span>
                </div>
                <p className="small">“{e.b.reason}”</p>
                <span className={`tag ${e.b.reviewed ? (e.b.outcome === 'justified' ? 'ok' : 'bad') : 'warn'}`}>
                  {e.b.reviewed ? `reviewed: ${e.b.outcome}` : 'awaiting review'}
                </span>
              </li>
            ),
          )}
        </ol>
      )}
    </>
  );
}
