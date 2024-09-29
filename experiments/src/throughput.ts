// E2: BFT (ehrchannel) vs etcdraft (ehrraft) on the same four orderers. Closed-loop clients
// submit CreateRecord with a 2 KiB transient PHI payload; each client waits for commit before
// sending the next. Reports committed TPS and endorse / submit->commit latency.
//
//   pnpm -C experiments throughput [--duration 45] [--levels 1,8,32,64]
import { randomBytes } from 'node:crypto';
import { sealPhi } from '../../gateway/src/envelope.js';
import { connectAs } from './lib/fabric.js';
import { sleep, writeResult } from './lib/manifest.js';
import { summary } from './lib/stats.js';

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : dflt;
};
const DURATION = Number(arg('duration', '45')) * 1000;
const LEVELS = arg('levels', '1,8,32,64').split(',').map(Number);
const CHANNELS = [
  { channel: 'ehrchannel', consensus: 'SmartBFT' },
  { channel: 'ehrraft', consensus: 'etcdraft' },
];

async function level(channel: string, concurrency: number) {
  const conn = connectAs('org1', 'drchen', channel);
  const endorse: number[] = [];
  const commit: number[] = [];
  const total: number[] = [];
  const errors: Record<string, number> = {};
  let committed = 0;
  const stopAt = Date.now() + DURATION;
  const worker = async () => {
    while (Date.now() < stopAt) {
      const phi = JSON.stringify({ note: randomBytes(1000).toString('hex').slice(0, 2048 - 20) });
      const t0 = performance.now();
      try {
        const tx = await conn.contract.newProposal('CreateRecord', { arguments: ['P-1001', 'lab'], transientData: { phi: sealPhi(phi) } }).endorse();
        const t1 = performance.now();
        const sub = await tx.submit();
        const status = await sub.getStatus();
        const t2 = performance.now();
        if (status.successful) {
          committed++;
          endorse.push(t1 - t0);
          commit.push(t2 - t1);
          total.push(t2 - t0);
        } else {
          errors[`commit:${status.code}`] = (errors[`commit:${status.code}`] ?? 0) + 1;
        }
      } catch (err) {
        const k = (err as Error).name ?? 'Error';
        errors[k] = (errors[k] ?? 0) + 1;
        await sleep(100);
      }
    }
  };
  const t0 = Date.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsed = (Date.now() - t0) / 1000;
  conn.close();
  return {
    channel,
    concurrency,
    durationS: Math.round(elapsed * 10) / 10,
    committed,
    tps: Math.round((committed / elapsed) * 10) / 10,
    endorseMs: summary(endorse),
    submitToCommitMs: summary(commit),
    totalMs: summary(total),
    errors,
  };
}

async function main() {
  const rows = [];
  for (const c of CHANNELS) await level(c.channel, 1).catch(() => undefined); // warm both chaincode containers
  // Interleave the channels and alternate which goes first, so neither one always runs on the
  // bigger ledger or the warmer host.
  for (const [i, n] of LEVELS.entries()) {
    const order = i % 2 === 0 ? CHANNELS : [...CHANNELS].reverse();
    for (const c of order) {
      const r = await level(c.channel, n);
      console.log(`${c.consensus} c=${n}: ${r.tps} TPS, commit p50 ${r.submitToCommitMs.p50} ms, p95 ${r.submitToCommitMs.p95} ms`);
      rows.push({ consensus: c.consensus, order: order.map((o) => o.consensus).join(' then '), ...r });
      await sleep(3000);
    }
  }
  writeResult(
    'throughput',
    {
      description: 'Closed-loop CreateRecord (2 KiB transient PHI) through one Org1 gateway peer; MAJORITY endorsement (Org1+Org2).',
      config: {
        durationS: DURATION / 1000,
        levels: LEVELS,
        ordering: 'channels interleaved per level, alternating which runs first',
        orderers: 4,
        bft: 'SmartBFT, RequestBatchMaxInterval 50ms; RequestBatchMaxCount comes from BatchSize.MaxMessageCount = 10 (orderer/consensus/smartbft/util.go:460 in v3.1.5)',
        raft: 'etcdraft on the same 4 orderer processes, BatchTimeout 50ms, MaxMessageCount 10',
      },
      rows,
    },
    { device: 'docker-desktop-arm64', workload: 'CreateRecord-2KiB' },
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
