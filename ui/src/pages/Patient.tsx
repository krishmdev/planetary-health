import { AccessLog } from '../components/AccessLog';
import { ConsentForm, ConsentList } from '../components/Consents';
import { Records } from '../components/Records';
import { useSession } from '../session';

export function Patient() {
  const { session } = useSession();
  const me = session!.user;
  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">Patient · {me.ehrId}</p>
          <h1>Your records</h1>
        </div>
        <p className="muted small" style={{ maxWidth: '44ch' }}>
          You decide who can read what, and for how long. Revoking takes effect at the next block, for new requests and for grants already issued.
        </p>
      </div>
      <div className="grid">
        <div className="stack">
          <section className="card reveal">
            <header>
              <h2>Records</h2>
              <span className="xs muted">health data stays in a private collection; only its fingerprint is on the ledger</span>
            </header>
            <Records patientId={me.ehrId} />
          </section>
          <section className="card reveal">
            <header>
              <h2>Who has looked</h2>
              <span className="xs muted">access log</span>
            </header>
            <AccessLog patientId={me.ehrId} allowRevoke />
          </section>
        </div>
        <div className="stack">
          <section className="card reveal">
            <header>
              <h2>Share with a clinician</h2>
            </header>
            <div className="body">
              <ConsentForm />
            </div>
          </section>
          <section className="card reveal">
            <header>
              <h2>Your consents</h2>
            </header>
            <ConsentList asPatient />
          </section>
        </div>
      </div>
    </>
  );
}
