import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import type { Consent, Member, Receipt } from '../api';
import { useSession } from '../session';
import { Empty, ErrorState, Loading, TxReceipt, until, when } from './states';

const TYPES = ['lab', 'imaging', 'note', 'rx', 'allergy'] as const;

export function ConsentForm() {
  const { api } = useSession();
  const qc = useQueryClient();
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api<Member[]>('GET', '/providers') });
  const [grantee, setGrantee] = useState('');
  const [types, setTypes] = useState<string[]>(['lab']);
  const [actions, setActions] = useState<string[]>(['read']);
  const [days, setDays] = useState(30);
  const [purpose, setPurpose] = useState('ongoing care');
  const grant = useMutation({
    mutationFn: () =>
      api<{ result: Consent; receipt: Receipt }>('POST', '/consents', {
        grantee,
        types,
        actions,
        purpose,
        expiresAt: new Date(Date.now() + days * 86400_000).toISOString(),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['consents'] }),
  });
  const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    grant.mutate();
  };
  const active = providers.data?.filter((p) => p.active) ?? [];
  return (
    <form className="form" onSubmit={submit} aria-label="Grant consent">
      <label>
        Clinician
        <select required value={grantee} onChange={(e) => setGrantee(e.target.value)} disabled={providers.isPending}>
          <option value="">{providers.isPending ? 'Loading directory…' : 'Choose a clinician'}</option>
          {active.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id} · {p.specialty || 'clinician'} · {p.org === 'Org1MSP' ? 'Mercy General' : 'Riverside Clinic'}
            </option>
          ))}
        </select>
      </label>
      {providers.error && <ErrorState error={providers.error} onRetry={() => providers.refetch()} />}
      {providers.data && active.length === 0 && <p className="hint">No clinicians are registered yet, so there is nobody to share with.</p>}
      <fieldset>
        <legend>Record types they may see</legend>
        <div className="checks">
          {TYPES.map((t) => (
            <label key={t}>
              <input type="checkbox" checked={types.includes(t)} onChange={() => toggle(types, setTypes, t)} /> {t}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>What they may do</legend>
        <div className="checks">
          <label>
            <input type="checkbox" checked={actions.includes('read')} onChange={() => toggle(actions, setActions, 'read')} /> read
          </label>
          <label>
            <input type="checkbox" checked={actions.includes('append')} onChange={() => toggle(actions, setActions, 'append')} /> add records
          </label>
        </div>
      </fieldset>
      <div className="form-row">
        <label>
          Expires after
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[1, 7, 30, 90, 365].map((d) => (
              <option key={d} value={d}>
                {d === 1 ? '1 day' : `${d} days`}
              </option>
            ))}
          </select>
        </label>
        <label>
          Purpose
          <input value={purpose} onChange={(e) => setPurpose(e.target.value)} minLength={3} required />
        </label>
      </div>
      <div className="spread">
        <p className="xs muted">Signed with your own certificate. Both hospitals endorse it.</p>
        <button type="submit" disabled={active.length === 0 || !grantee || types.length === 0 || actions.length === 0 || grant.isPending}>
          {grant.isPending ? 'Recording…' : 'Grant consent'}
        </button>
      </div>
      {grant.error && <ErrorState error={grant.error} afterAction />}
      {grant.data && <TxReceipt receipt={grant.data.receipt} label={`consent ${grant.data.result.consentId}`} />}
    </form>
  );
}

export function ConsentList({ asPatient }: { asPatient: boolean }) {
  const { api } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['consents'], queryFn: () => api<Consent[]>('GET', '/consents') });
  const [last, setLast] = useState<{ receipt: Receipt; id: string } | null>(null);
  const revoke = useMutation({
    mutationFn: (id: string) => api<{ receipt: Receipt }>('DELETE', `/consents/${id}`).then((r) => ({ ...r, id })),
    onSuccess: (r) => {
      setLast({ receipt: r.receipt, id: r.id });
      qc.invalidateQueries({ queryKey: ['consents'] });
    },
  });
  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const rows = [...q.data].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (rows.length === 0)
    return <Empty title={asPatient ? 'You haven’t shared anything' : 'No patient has consented yet'}>{asPatient ? 'Nobody outside your own care can read your records.' : 'Patients grant access from their own view.'}</Empty>;
  return (
    <div className="table-wrap">
      <table className="table stackable">
        <caption className="sr-only">Consents</caption>
        <thead>
          <tr>
            <th>{asPatient ? 'Clinician' : 'Patient'}</th>
            <th>Scope</th>
            <th>Status</th>
            {asPatient && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const expired = new Date(c.expiresAt) <= new Date();
            const live = c.status === 'active' && !expired;
            return (
              <tr key={c.consentId}>
                <td className="purpose" data-label={asPatient ? 'Clinician' : 'Patient'}>
                  <strong className="mono">{asPatient ? c.grantee : c.patientId}</strong>
                  <div className="xs muted">{c.purpose}</div>
                </td>
                <td data-label="Scope">
                  <div className="tags">
                    {c.types.map((t) => (
                      <span key={t} className="tag">
                        {t}
                      </span>
                    ))}
                  </div>
                  <div className="xs muted" style={{ marginTop: 4 }}>
                    {c.actions.join(' + ')}
                  </div>
                </td>
                <td data-label="Status">
                  {live ? (
                    <span className="tag ok">
                      <span className="dot" /> active · {until(c.expiresAt)}
                    </span>
                  ) : c.status === 'revoked' ? (
                    <span className="tag bad">revoked {when(c.revokedAt)}</span>
                  ) : (
                    <span className="tag warn">expired {when(c.expiresAt)}</span>
                  )}
                </td>
                {asPatient && (
                  <td className="actions">
                    {live && (
                      <button
                        type="button"
                        className="ghost"
                        aria-label={`Revoke consent for ${c.grantee} (${c.types.join(', ')})`}
                        onClick={() => revoke.mutate(c.consentId)}
                        disabled={revoke.isPending}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {revoke.error && <ErrorState error={revoke.error} afterAction />}
      {last && (
        <div className="body">
          <TxReceipt receipt={last.receipt} label={`revoked ${last.id}`} />
        </div>
      )}
    </div>
  );
}
