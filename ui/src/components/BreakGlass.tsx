import { useMutation } from '@tanstack/react-query';
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import type { BreakGlass as BG, Receipt } from '../api';
import { useSession } from '../session';
import { ErrorState, TxReceipt } from './states';

// Break-glass deliberately has friction: a written reason, an explicit acknowledgement, and
// retyping the patient ID. It is logged, emits an event, and goes to an admin review queue.
export function BreakGlassModal({ onClose, onGranted, initialPatient = '' }: { onClose: () => void; onGranted: (pid: string) => void; initialPatient?: string }) {
  const { api } = useSession();
  const [pid, setPid] = useState(initialPatient);
  const [confirmPid, setConfirmPid] = useState('');
  const [reason, setReason] = useState('');
  const [ack, setAck] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLInputElement>(null);
  const m = useMutation({
    mutationFn: () => api<{ result: BG; receipt: Receipt }>('POST', '/emergency', { patientId: pid.trim(), reason: reason.trim() }),
    onSuccess: (r) => onGranted(r.result.patientId),
  });

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    first.current?.focus();
    return () => opener?.focus();
  }, []);

  // Keep Tab inside the dialog; Escape closes it.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !dialog.current) return;
    const items = [...dialog.current.querySelectorAll<HTMLElement>('input, textarea, button, select, [href]')].filter((el) => !el.hasAttribute('disabled'));
    if (items.length === 0) return;
    const firstEl = items[0]!;
    const lastEl = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === firstEl) {
      e.preventDefault();
      lastEl.focus();
    } else if (!e.shiftKey && document.activeElement === lastEl) {
      e.preventDefault();
      firstEl.focus();
    }
  };

  const trimmed = pid.trim();
  const mismatch = confirmPid !== '' && confirmPid.trim() !== trimmed;
  const reasonLeft = Math.max(0, 10 - reason.trim().length);
  const missing = [
    trimmed.length < 3 && 'enter the patient ID',
    trimmed.length >= 3 && confirmPid.trim() !== trimmed && (confirmPid === '' ? 'retype the patient ID' : 'the two patient IDs don’t match'),
    reasonLeft > 0 && `${reasonLeft} more character${reasonLeft === 1 ? '' : 's'} of reason`,
    !ack && 'tick the acknowledgement',
  ].filter(Boolean) as string[];
  const ready = missing.length === 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) m.mutate();
  };

  return (
    <div className="backdrop" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="bg-title" ref={dialog} onKeyDown={onKeyDown}>
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
              <input ref={first} value={pid} onChange={(e) => setPid(e.target.value)} placeholder="P-1002" required autoComplete="off" disabled={!!m.data} />
            </label>
            <label>
              Retype patient ID
              <input value={confirmPid} onChange={(e) => setConfirmPid(e.target.value)} required autoComplete="off" aria-invalid={mismatch} disabled={!!m.data} />
            </label>
          </div>
          <label>
            Clinical reason (at least 10 characters, stored on the ledger)
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} required minLength={10} disabled={!!m.data} />
          </label>
          <label className="row" style={{ fontWeight: 400 }}>
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={{ width: 'auto' }} disabled={!!m.data} />I understand this access is
            audited and reviewed.
          </label>
          {m.error && <ErrorState error={m.error} afterAction />}
          {m.data && <TxReceipt receipt={m.data.receipt} label={`emergency grant ${m.data.result.grantId} · expires ${new Date(m.data.result.expiresAt).toLocaleTimeString()}`} />}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            {m.data ? (
              <button type="button" onClick={onClose}>
                Done
              </button>
            ) : (
              <>
                <button type="button" className="ghost" onClick={onClose}>
                  Cancel
                </button>
                <button type="submit" className="danger" disabled={!ready || m.isPending} aria-describedby="bg-missing">
                  {m.isPending ? 'Recording…' : 'Request emergency access'}
                </button>
              </>
            )}
          </div>
          {!m.data && (
            <p id="bg-missing" className={`hint ${ready ? '' : 'missing'}`} aria-live="polite" style={{ textAlign: 'right' }}>
              {ready ? 'Ready to record.' : `Still needed: ${missing.join(', ')}.`}
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
