import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import type { Consent, RecordMeta, Receipt } from '../api';
import { BreakGlassModal } from '../components/BreakGlass';
import { Records } from '../components/Records';
import { Empty, ErrorState, Loading, TxReceipt, until } from '../components/states';
import { useSession } from '../session';

function NewRecord({ patientId }: { patientId: string }) {
  const { api } = useSession();
  const qc = useQueryClient();
  const [type, setType] = useState('note');
  const [text, setText] = useState('');
  const m = useMutation({
    mutationFn: () => api<{ record: RecordMeta; receipt: Receipt }>('POST', `/patients/${patientId}/records`, { type, phi: { text } }),
    onSuccess: () => {
      setText('');
      qc.invalidateQueries({ queryKey: ['records', patientId] });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  return (
    <form className="form" onSubmit={submit} aria-label="Add a record">
      <div className="form-row">
        <label>
          Type
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {['note', 'lab', 'rx', 'allergy', 'imaging'].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <div className="xs muted" style={{ alignSelf: 'end' }}>
          Sent as transient data. Only its SHA-256 goes into the block.
        </div>
      </div>
      <label>
        Clinical content
        <textarea value={text} onChange={(e) => setText(e.target.value)} required />
      </label>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="submit" disabled={!text.trim() || m.isPending}>
          {m.isPending ? 'Endorsing at both hospitals…' : 'Add record'}
        </button>
      </div>
      {m.error && <ErrorState error={m.error} />}
      {m.data && <TxReceipt receipt={m.data.receipt} label={`record ${m.data.record.recordId}`} />}
    </form>
  );
}

export function Doctor() {
  const { session, api } = useSession();
  const me = session!.user;
  const consents = useQuery({ queryKey: ['consents'], queryFn: () => api<Consent[]>('GET', '/consents') });
  const [patient, setPatient] = useState<string | null>(null);
  const [emergency, setEmergency] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState(false);

  const live = (consents.data ?? []).filter((c) => c.status === 'active' && new Date(c.expiresAt) > new Date());
  const patients = [...new Set([...live.map((c) => c.patientId), ...emergency])];
  const selected = patient ?? patients[0] ?? null;

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">
            {me.specialty ?? 'Clinician'} · {me.ehrId}
          </p>
          <h1>Patients who shared with you</h1>
        </div>
        <button type="button" className="danger" onClick={() => setModal(true)}>
          Emergency access…
        </button>
      </div>
      <div className="grid">
        <div className="stack">
          <section className="card reveal">
            <header>
              <h2>{selected ? `Records for ${selected}` : 'Records'}</h2>
              {selected && emergency.has(selected) && <span className="tag bad">emergency access · 60 min</span>}
            </header>
            {selected ? <Records patientId={selected} /> : <Empty title="Choose a patient">Patients appear once they grant you consent.</Empty>}
          </section>
          {selected && (
            <section className="card reveal">
              <header>
                <h2>Add to the record</h2>
                <span className="xs muted">needs “add records” consent or emergency access</span>
              </header>
              <div className="body">
                <NewRecord patientId={selected} />
              </div>
            </section>
          )}
        </div>
        <section className="card reveal">
          <header>
            <h2>Consents to you</h2>
          </header>
          {consents.isPending ? (
            <Loading />
          ) : consents.error ? (
            <ErrorState error={consents.error} onRetry={() => consents.refetch()} />
          ) : patients.length === 0 ? (
            <Empty title="No active consents">When a patient shares records with you, they show up here with the scope and expiry they chose.</Empty>
          ) : (
            <div className="people body">
              {patients.map((pid) => {
                const cs = live.filter((c) => c.patientId === pid);
                return (
                  <button key={pid} type="button" className="person" aria-pressed={selected === pid} onClick={() => setPatient(pid)}>
                    <span className="avatar" aria-hidden>
                      {pid.slice(-2)}
                    </span>
                    <span>
                      <strong className="mono">{pid}</strong>
                      <span className="xs muted" style={{ display: 'block' }}>
                        {cs.length ? cs.map((c) => `${c.types.join(', ')} · ${c.actions.join('+')} · ${until(c.expiresAt)}`).join(' / ') : 'emergency access only'}
                      </span>
                    </span>
                    {emergency.has(pid) ? <span className="tag bad">emergency</span> : <span className="tag ok">consent</span>}
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </div>
      {modal && (
        <BreakGlassModal
          onClose={() => setModal(false)}
          onGranted={(pid) => {
            setEmergency((s) => new Set(s).add(pid));
            setPatient(pid);
            setTimeout(() => setModal(false), 1600);
          }}
        />
      )}
    </>
  );
}
