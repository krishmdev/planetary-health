import { useQuery } from '@tanstack/react-query';
import type { NetworkStatus } from '../api';
import { useSession } from '../session';
import { ErrorState, Loading } from './states';

// Four SmartBFT orderers. Commits need ceil((n+f+1)/2) = 3 of them; the panel shows which are
// up, which one leads, and the channel height.
export function NetworkPanel() {
  const { api } = useSession();
  const q = useQuery({ queryKey: ['network'], queryFn: () => api<NetworkStatus>('GET', '/network/status'), refetchInterval: 4000 });
  if (q.isPending) return <Loading rows={2} label="Checking the network" />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const s = q.data;
  return (
    <div className="body stack">
      <div className="ring" role="list" aria-label="Ordering service nodes">
        {s.orderers.map((o, i) => {
          const id = i + 1;
          const leader = s.bftLeader === id;
          return (
            <div key={o.name} role="listitem" className={`node ${o.up ? 'up' : 'down'} ${leader ? 'leader' : ''}`} aria-label={`${o.name} ${o.up ? 'up' : 'down'}${leader ? ', leader' : ''}`}>
              {leader && <span className="crown">leader</span>}
              <span className="light" aria-hidden />
              <strong className="small">orderer{id === 1 ? '' : id}</strong>
              <span className="xs muted">{o.up ? `${o.ms} ms` : o.status}</span>
            </div>
          );
        })}
      </div>
      <div className="spread">
        <div className="stat">
          <span className="eyebrow">Block height</span>
          <span className="v">{s.ordererHeight ?? '—'}</span>
        </div>
        <div className="stat">
          <span className="eyebrow">BFT leader</span>
          <span className="v">{s.bftLeader ?? '—'}</span>
        </div>
        <div className="stat">
          <span className="eyebrow">Quorum</span>
          <span className="v">
            {s.quorum.live}/{s.quorum.total}
          </span>
        </div>
      </div>
      {s.quorum.ok ? (
        <p className="banner teal">
          {s.quorum.live} of {s.quorum.total} orderers up; {s.quorum.needed} are needed to commit. {s.quorum.live - s.quorum.needed === 1 ? 'One more can fail.' : s.quorum.live === s.quorum.needed ? 'No further failures tolerated.' : ''}
        </p>
      ) : (
        <p className="banner red">
          Only {s.quorum.live} orderers up; {s.quorum.needed} are needed. Writes return 503 until one comes back.
        </p>
      )}
      <div className="row">
        {s.peers.map((p) => (
          <span key={p.name} className={`tag ${p.up ? 'ok' : 'bad'}`}>
            <span className="dot" /> {p.name} {p.height !== undefined ? `· height ${p.height}` : ''}
          </span>
        ))}
      </div>
      <p className="xs muted">Checked {new Date(s.checkedAt).toLocaleTimeString()} via {s.org} gateway · channel {s.channel}</p>
    </div>
  );
}
