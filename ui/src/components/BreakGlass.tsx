import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import type { BreakGlass as BG, Receipt } from '../api';
import { useSession } from '../session';
import { ErrorState, TxReceipt } from './states';

// Break-glass deliberately has friction: a written reason, an explicit acknowledgement, and
// retyping the patient ID. It is logged, emits an event, and goes to an admin review queue.
export function BreakGlassModal({ onClose, onGranted }: { onClose: () => void; onGranted: (pid: string) => void }) {
  const { api } = useSession();
  const [pid, setPid] = useState('');
  const [confirmPid, setConfirmPid] = useState('');
  const [reason, setReason] = useState('');
  const [ack, setAck] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  const m = useMutation({
    mutationFn: () => api<{ result: BG; receipt: Receipt }>('POST', '/emergency', { patientId: pid.trim(), reason: reason.trim() }),
    onSuccess: (r) => onGranted(r.result.patientId),
  });
  useEffect(() => {
    first.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  const ready = pid.trim().length >= 3 && confirmPid.trim() === pid.trim() && reason.trim().length >= 10 && ack;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) m.mutate();
  };
  return (
    <div className="backdrop" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="bg-title">
        <header>
          <p className="eyebrow" style={{ color: 'var(--red)' }}>
            Emergency access
          </p>
          <h2 id="bg-title">Break the glass</h2>
        </header>
        <form className="body" onSubmit={submit}>
          <div className="banner red">
            Use this only when a patient needs care and consent can’t be obtained. Access lasts 60 minutes, the patient sees it in their access log, and the patient’s
            hospital reviews every use.
          </div>
          <div className="form-row">
            <label>
              Patient ID
              <input ref={first} value={pid} onChange={(e) => setPid(e.target.value)} placeholder="P-1002" required autoComplete="off" />
            </label>
            <label>
              Retype patient ID
              <input value={confirmPid} onChange={(e) => setConfirmPid(e.target.value)} required autoComplete="off" aria-invalid={confirmPid !== '' && confirmPid !== pid} />
            </label>
          </div>
          <label>
            Clinical reason (at least 10 characters, stored on the ledger)
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} required minLength={10} />
          </label>
          <label className="row" style={{ fontWeight: 400 }}>
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={{ width: 'auto' }} />I understand this access is audited and reviewed.
          </label>
          {m.error && <ErrorState error={m.error} />}
          {m.data && <TxReceipt receipt={m.data.receipt} label={`emergency grant ${m.data.result.grantId}`} />}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="danger" disabled={!ready || m.isPending}>
              {m.isPending ? 'Recording…' : 'Request emergency access'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
