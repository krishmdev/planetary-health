import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import type { BreakGlass, Member, Receipt, Role } from '../api';
import { AccessLog } from '../components/AccessLog';
import { NetworkPanel } from '../components/NetworkPanel';
import { Empty, ErrorState, Loading, TxReceipt, until, when } from '../components/states';
import { useSession } from '../session';

function Reviews() {
  const { api } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['reviews'], queryFn: () => api<BreakGlass[]>('GET', '/emergency/reviews'), refetchInterval: 10000 });
  const review = useMutation({
    mutationFn: (v: { id: string; outcome: string }) =>
      api<{ receipt: Receipt }>('POST', `/emergency/${v.id}/review`, { outcome: v.outcome, note: v.outcome === 'justified' ? 'confirmed with ER log' : 'no matching admission' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reviews'] }),
  });
  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (q.data.length === 0) return <Empty title="Nothing to review">Every emergency access to one of your patients lands here.</Empty>;
  return (
    <ol className="timeline">
      {q.data.map((g) => (
        <li key={g.grantId} className="emergency">
          <div className="spread">
            <strong>
              {g.providerId} → {g.patientId}
            </strong>
            <span className="xs muted">
              {when(g.createdAt)} · {until(g.expiresAt)}
            </span>
          </div>
          <p className="small">“{g.reason}”</p>
          <p className="xs muted">from {g.providerOrg === 'Org1MSP' ? 'Mercy General' : 'Riverside Clinic'}</p>
          <div className="row" style={{ marginTop: 6 }}>
            <button type="button" className="ghost" disabled={review.isPending} onClick={() => review.mutate({ id: g.grantId, outcome: 'justified' })}>
              Justified
            </button>
            <button type="button" className="danger" disabled={review.isPending} onClick={() => review.mutate({ id: g.grantId, outcome: 'unjustified' })}>
              Unjustified, end access
            </button>
          </div>
        </li>
      ))}
      {review.error && <ErrorState error={review.error} />}
    </ol>
  );
}

function Members({ onAudit }: { onAudit: (pid: string) => void }) {
  const { api, session } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['members'], queryFn: () => api<Member[]>('GET', '/admin/members') });
  const deactivate = useMutation({
    mutationFn: (id: string) => api<{ receipt: Receipt }>('POST', `/admin/members/${id}/deactivate`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['members'] }),
  });
  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">Registry entries for this hospital</caption>
        <thead>
          <tr>
            <th>ID</th>
            <th>Role</th>
            <th>Certificate</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {q.data.map((m) => (
            <tr key={m.id}>
              <td className="mono">{m.id}</td>
              <td>{m.role}</td>
              <td className="mono xs">{m.enrollmentId}</td>
              <td>{m.active ? <span className="tag ok">active</span> : <span className="tag bad">deactivated</span>}</td>
              <td>
                <div className="row" style={{ justifyContent: 'flex-end' }}>
                  {m.role === 'patient' && (
                    <button type="button" className="link" onClick={() => onAudit(m.id)}>
                      audit
                    </button>
                  )}
                  {m.active && m.id !== session!.user.ehrId && (
                    <button type="button" className="ghost" onClick={() => deactivate.mutate(m.id)} disabled={deactivate.isPending}>
                      Deactivate
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {deactivate.error && <ErrorState error={deactivate.error} />}
    </div>
  );
}

function Register() {
  const { api } = useSession();
  const qc = useQueryClient();
  const [f, setF] = useState({ username: '', displayName: '', role: 'patient' as Role, ehrId: '', password: '', specialty: '' });
  const m = useMutation({
    mutationFn: () => api<{ member: Member; receipt: Receipt }>('POST', '/admin/users', { ...f, specialty: f.specialty || undefined }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['members'] }),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  return (
    <form className="form" onSubmit={submit} aria-label="Register a user">
      <div className="form-row">
        <label>
          Username
          <input value={f.username} onChange={set('username')} pattern="[a-z0-9][a-z0-9._-]{1,63}" required />
        </label>
        <label>
          Full name
          <input value={f.displayName} onChange={set('displayName')} required />
        </label>
      </div>
      <div className="form-row">
        <label>
          Role (becomes a certificate attribute)
          <select value={f.role} onChange={set('role')}>
            <option value="patient">patient</option>
            <option value="doctor">doctor</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <label>
          EHR ID
          <input value={f.ehrId} onChange={set('ehrId')} placeholder={f.role === 'patient' ? 'P-1003' : f.role === 'doctor' ? 'D-2002' : 'A-1002'} required />
        </label>
      </div>
      <div className="form-row">
        <label>
          Initial password
          <input type="password" value={f.password} onChange={set('password')} minLength={8} required />
        </label>
        {f.role === 'doctor' && (
          <label>
            Specialty
            <input value={f.specialty} onChange={set('specialty')} />
          </label>
        )}
      </div>
      <p className="xs muted">Registers and enrolls the user with this hospital’s CA, stores the key in the custodial wallet, and writes the registry entry on-chain.</p>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="submit" disabled={m.isPending}>
          {m.isPending ? 'Enrolling…' : 'Register'}
        </button>
      </div>
      {m.error && <ErrorState error={m.error} />}
      {m.data && <TxReceipt receipt={m.data.receipt} label={`registered ${m.data.member.id}`} />}
    </form>
  );
}

export function Admin() {
  const { session } = useSession();
  const [audit, setAudit] = useState<string | null>(null);
  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">Administrator · {session!.user.ehrId}</p>
          <h1>Registry, reviews and network</h1>
        </div>
        <p className="muted small" style={{ maxWidth: '44ch' }}>
          Administrators see metadata only. Reading health information is refused by the policy on both hospitals’ peers.
        </p>
      </div>
      <div className="grid">
        <div className="stack">
          <section className="card reveal">
            <header>
              <h2>Emergency access reviews</h2>
            </header>
            <Reviews />
          </section>
          <section className="card reveal">
            <header>
              <h2>Registry</h2>
              <span className="xs muted">on-chain status, checked in every transaction</span>
            </header>
            <Members onAudit={setAudit} />
          </section>
          {audit && (
            <section className="card reveal">
              <header>
                <h2>Audit trail · {audit}</h2>
                <button type="button" className="link" onClick={() => setAudit(null)}>
                  close
                </button>
              </header>
              <AccessLog patientId={audit} />
            </section>
          )}
        </div>
        <div className="stack">
          <section className="card reveal">
            <header>
              <h2>Ordering service</h2>
              <span className="xs muted">SmartBFT, f = 1</span>
            </header>
            <NetworkPanel />
          </section>
          <section className="card reveal">
            <header>
              <h2>Register a user</h2>
            </header>
            <div className="body">
              <Register />
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
