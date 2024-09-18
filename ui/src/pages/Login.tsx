import { type FormEvent, useState } from 'react';
import { ApiError, ORGS, type OrgKey, type Role } from '../api';
import { ErrorState } from '../components/states';
import { useSession } from '../session';

// Demo accounts seeded by `pnpm -C gateway seed`. Passwords are "<username>-demo".
const PEOPLE: Record<OrgKey, { username: string; name: string; role: Role; note: string }[]> = {
  org1: [
    { username: 'alice', name: 'Alice Moreno', role: 'patient', note: 'P-1001 · has records and consents' },
    { username: 'ben', name: 'Ben Carter', role: 'patient', note: 'P-1002 · no consents yet' },
    { username: 'drchen', name: 'Dr. Lin Chen', role: 'doctor', note: 'D-2001 · cardiology' },
    { username: 'ada', name: 'Ada Okafor', role: 'admin', note: 'A-1001 · Mercy administrator' },
  ],
  org2: [
    { username: 'drrivera', name: 'Dr. Sofia Rivera', role: 'doctor', note: 'D-3001 · emergency medicine' },
    { username: 'omar', name: 'Omar Haddad', role: 'admin', note: 'A-3001 · Riverside administrator' },
  ],
};

const initials = (n: string) =>
  n
    .replace('Dr. ', '')
    .split(' ')
    .map((p) => p[0])
    .join('');

export function Login() {
  const { login, notice } = useSession();
  const [org, setOrg] = useState<OrgKey>('org1');
  const [username, setUsername] = useState('alice');
  const [password, setPassword] = useState('alice-demo');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const pick = (u: string) => {
    setUsername(u);
    setPassword(`${u}-demo`);
    setError(null);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(org, username, password);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <section className="intro">
        <div className="stack">
          <p className="eyebrow">Planetary Health · shared records</p>
          <h1>One patient record, two hospitals, no single owner.</h1>
          <p className="muted" style={{ maxWidth: '52ch' }}>
            Records live on a Hyperledger Fabric channel run by Mercy General and Riverside Clinic, ordered by four Byzantine-fault-tolerant orderers. Every read of
            health information needs the patient’s consent or a reviewed emergency grant, and both hospitals check that policy independently.
          </p>
        </div>
        <ul className="small muted" style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>
          <li>Sign in at your own hospital’s gateway. It signs with your personal certificate.</li>
          <li>Demo data only. No real patient information.</li>
        </ul>
      </section>
      <section className="pick">
        {notice && (
          <p className="banner amber" role="status">
            {notice}
          </p>
        )}
        <div className="stack" style={{ gap: 12 }}>
          <h2>Sign in</h2>
          <div className="tabs" role="tablist" aria-label="Hospital">
            {(Object.keys(ORGS) as OrgKey[]).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={org === k}
                onClick={() => {
                  setOrg(k);
                  pick(PEOPLE[k][0]!.username);
                }}
              >
                {ORGS[k].name}
              </button>
            ))}
          </div>
        </div>
        <div className="people" role="group" aria-label="Demo accounts">
          {PEOPLE[org].map((p) => (
            <button key={p.username} type="button" className="person" aria-pressed={username === p.username} onClick={() => pick(p.username)}>
              <span className="avatar" aria-hidden>
                {initials(p.name)}
              </span>
              <span>
                <strong>{p.name}</strong>
                <span className="xs muted" style={{ display: 'block' }}>
                  {p.note}
                </span>
              </span>
              <span className="tag">{p.role}</span>
            </button>
          ))}
        </div>
        <form className="form" onSubmit={submit}>
          <div className="form-row">
            <label>
              Username
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
            </label>
            <label>
              Password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
            </label>
          </div>
          {error instanceof ApiError && error.status === 401 ? (
            <p className="banner red" role="alert">
              Wrong username or password for {ORGS[org].name}. Accounts only exist at their own hospital.
            </p>
          ) : error ? (
            <ErrorState error={error} />
          ) : null}
          <button type="submit" disabled={busy}>
            {busy ? 'Signing in… (a sleeping gateway may take a few seconds to wake)' : `Sign in to ${ORGS[org].name}`}
          </button>
        </form>
      </section>
    </main>
  );
}
