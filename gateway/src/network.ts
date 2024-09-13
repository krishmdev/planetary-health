// Network health for the UI's network panel, read from the orderers' and peers' operations
// endpoints (plain HTTP /healthz and Prometheus /metrics on the test network).

export interface NodeHealth {
  name: string;
  url: string;
  up: boolean;
  status?: string;
  height?: number;
  leader?: number;
  ms: number;
}

export interface NetworkStatus {
  channel: string;
  orderers: NodeHealth[];
  peers: NodeHealth[];
  bftLeader: number | null;
  ordererHeight: number | null;
  quorum: { live: number; needed: number; total: number; ok: boolean };
  checkedAt: string;
}

export type Fetcher = (url: string, timeoutMs: number) => Promise<{ status: number; text: string }>;

export const httpFetch: Fetcher = async (url, timeoutMs) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, text: await res.text() };
};

export function metric(text: string, name: string, channel: string): number | undefined {
  for (const line of text.split('\n')) {
    if (!line.startsWith(name)) continue;
    if (!line.includes(`channel="${channel}"`)) continue;
    const v = Number(line.trim().split(/\s+/).pop());
    if (Number.isFinite(v)) return v;
  }
  return undefined;
}

async function probe(fetcher: Fetcher, name: string, url: string, channel: string): Promise<NodeHealth> {
  const t0 = performance.now();
  try {
    const h = await fetcher(`${url}/healthz`, 1500);
    const node: NodeHealth = { name, url, up: h.status === 200, status: h.status === 200 ? 'OK' : `HTTP ${h.status}`, ms: 0 };
    if (node.up) {
      const m = await fetcher(`${url}/metrics`, 1500).catch(() => null);
      if (m) {
        node.height = metric(m.text, 'ledger_blockchain_height', channel);
        node.leader = metric(m.text, 'consensus_BFT_leader_id', channel);
      }
    }
    node.ms = Math.round(performance.now() - t0);
    return node;
  } catch {
    return { name, url, up: false, status: 'unreachable', ms: Math.round(performance.now() - t0) };
  }
}

export async function networkStatus(
  fetcher: Fetcher,
  channel: string,
  orderers: { name: string; ops: string }[],
  peers: { name: string; url: string }[],
  f: number,
): Promise<NetworkStatus> {
  const [os, ps] = await Promise.all([
    Promise.all(orderers.map((o) => probe(fetcher, o.name, o.ops, channel))),
    Promise.all(peers.map((p) => probe(fetcher, p.name, p.url, channel))),
  ]);
  const live = os.filter((o) => o.up);
  // Leader IDs reported by live orderers; they agree outside of a view change.
  const leaders = live.map((o) => o.leader).filter((l): l is number => l !== undefined);
  const heights = live.map((o) => o.height).filter((h): h is number => h !== undefined);
  const n = orderers.length;
  const needed = Math.ceil((n + f + 1) / 2);
  return {
    channel,
    orderers: os,
    peers: ps,
    bftLeader: leaders.length ? mode(leaders) : null,
    ordererHeight: heights.length ? Math.max(...heights) : null,
    quorum: { live: live.length, needed, total: n, ok: live.length >= needed },
    checkedAt: new Date().toISOString(),
  };
}

function mode(xs: number[]): number {
  const counts = new Map<number, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}
