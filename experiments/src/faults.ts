// E3: faults under steady load, for each channel:
//   t=30s   stop a follower orderer, restart it at t=60s
//   t=90s   stop the current leader
//   t=180s  stop a second orderer (two of four down)
//   t=210s  restart everything; run until t=300s
// Load: 8 closed-loop workers submitting Ping with a 10 s commit deadline.
// A separate probe submits one fresh Ping every second with an 8 s commit deadline. The
// workers can all be stuck waiting on commits nobody will make; the probe keeps sending, so it
// is what measures the quorum error, leader-stop -> next commit and restart -> next commit.
//
//   pnpm -C experiments faults [--channels ehrchannel,ehrraft]
import { docker } from './lib/docker.js';
import { connectAs, leaderOf, ORDERERS } from './lib/fabric.js';
import { sleep, writeResult } from './lib/manifest.js';

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : dflt;
};
const CHANNELS = arg('channels', 'ehrchannel,ehrraft').split(',');
const END = 300;

interface Event {
  t: number;
  what: string;
}

interface ProbeResult {
  t: number;
  ok: boolean;
  ms: number;
  error?: string;
}

const describe = (err: unknown) => {
  const e = err as { message?: string; details?: { message: string }[] };
  return [e.message, ...(e.details ?? []).map((d) => d.message)].join(' | ').slice(0, 300);
};

async function run(channel: string) {
  const bft = channel === 'ehrchannel';
  const conn = connectAs('org1', 'drchen', channel, 10_000);
  const probeConn = connectAs('org1', 'drchen', channel, 8_000);
  const commitsAt: number[] = [];
  const errorsAt: { t: number; msg: string }[] = [];
  const probes: ProbeResult[] = [];
  const events: Event[] = [];
  const t0 = Date.now();
  const now = () => (Date.now() - t0) / 1000;
  let running = true;

  const worker = async () => {
    while (running) {
      try {
        const sub = await conn.contract.submitAsync('Ping');
        const status = await sub.getStatus();
        if (status.successful) commitsAt.push(now());
        else errorsAt.push({ t: now(), msg: `commit status ${status.code}` });
      } catch (err) {
        errorsAt.push({ t: now(), msg: describe(err) });
        await sleep(250);
      }
    }
  };
  const probe = async () => {
    while (running) {
      const started = now();
      const p0 = performance.now();
      probeConn.contract
        .submitAsync('Ping')
        .then((sub) => sub.getStatus())
        .then(
          (st) => probes.push({ t: started, ok: st.successful, ms: Math.round(performance.now() - p0), ...(st.successful ? {} : { error: `commit status ${st.code}` }) }),
          (err) => probes.push({ t: started, ok: false, ms: Math.round(performance.now() - p0), error: describe(err) }),
        );
      await sleep(1000);
    }
  };
  const workers = [...Array.from({ length: 8 }, worker), probe()];

  const at = async (t: number) => {
    while (now() < t) await sleep(100);
  };
  const stopped: string[] = [];
  const stop = async (name: string, why: string) => {
    await docker.stop(name, 2);
    stopped.push(name);
    events.push({ t: now(), what: `stop ${name} (${why})` });
  };

  await at(30);
  const leader1 = await leaderOf(channel, bft);
  const follower = ORDERERS.find((o) => o.name !== leader1?.name)!;
  await stop(follower.name, 'follower');
  await at(60);
  await docker.start(follower.name);
  events.push({ t: now(), what: `start ${follower.name}` });
  stopped.splice(stopped.indexOf(follower.name), 1);

  await at(90);
  const leader = (await leaderOf(channel, bft)) ?? leader1 ?? ORDERERS[0]!;
  await stop(leader.name, 'leader');
  const leaderStoppedAt = now();

  await at(180);
  const newLeader = await leaderOf(channel, bft, [leader.name]);
  const second = ORDERERS.find((o) => o.name !== leader.name && o.name !== newLeader?.name) ?? ORDERERS.find((o) => o.name !== leader.name)!;
  await stop(second.name, 'second failure: 2 of 4 down');
  const twoDownAt = now();

  await at(210);
  for (const n of [...stopped]) {
    await docker.start(n);
    events.push({ t: now(), what: `start ${n}` });
  }
  const restartedAt = now();
  await at(END);
  running = false;
  await Promise.race([Promise.all(workers), sleep(15_000)]);
  await sleep(9000); // let in-flight probes settle
  conn.close();
  probeConn.close();

  const perSecond = Array.from({ length: END }, (_, s) => ({
    t: s,
    commits: commitsAt.filter((c) => c >= s && c < s + 1).length,
    errors: errorsAt.filter((e) => e.t >= s && e.t < s + 1).length,
    probeOk: probes.some((p) => p.ok && p.t >= s && p.t < s + 1),
  }));
  const tps = (a: number, b: number) => Math.round((commitsAt.filter((c) => c >= a && c < b).length / (b - a)) * 10) / 10;
  // First probe *sent* after t that committed: the time until the channel accepted new work.
  const firstProbeOk = (t: number) => probes.filter((p) => p.ok && p.t >= t).sort((a, b) => a.t - b.t)[0];
  const since = (p: ProbeResult | undefined, t: number) => (p === undefined ? null : Math.round((p.t + p.ms / 1000 - t) * 10) / 10);
  const twoDownProbes = probes.filter((p) => p.t >= twoDownAt + 1 && p.t < restartedAt);
  const twoDownFailures = twoDownProbes.filter((p) => !p.ok);
  const errorKinds: Record<string, number> = {};
  for (const p of twoDownFailures) {
    const kind = p.error?.includes('insufficient number of orderers')
      ? 'quorum (insufficient number of orderers)'
      : p.error?.includes('commit status')
        ? p.error
        : /DEADLINE|deadline/i.test(p.error ?? '')
          ? 'commit deadline exceeded'
          : 'other';
    errorKinds[kind] = (errorKinds[kind] ?? 0) + 1;
  }
  return {
    channel,
    consensus: bft ? 'SmartBFT' : 'etcdraft',
    events,
    leaderBefore: leader.name,
    leaderAfter: newLeader?.name ?? null,
    phases: {
      baselineTps: tps(5, 30),
      followerDownTps: tps(32, 60),
      afterLeaderStopTps: tps(leaderStoppedAt, 180),
      twoDownCommits: commitsAt.filter((c) => c >= twoDownAt + 2 && c < restartedAt).length,
      recoveredTps: tps(restartedAt + 30, END),
    },
    leaderStopToNextCommitS: since(firstProbeOk(leaderStoppedAt), leaderStoppedAt),
    restartToNextCommitS: since(firstProbeOk(restartedAt), restartedAt),
    twoDownProbes: {
      sent: twoDownProbes.length,
      committed: twoDownProbes.filter((p) => p.ok).length,
      errorKinds,
      quorumMessageSeen: twoDownFailures.some((p) => p.error?.includes('insufficient number of orderers')),
      sample: twoDownFailures.slice(0, 2).map((p) => p.error),
    },
    probes: { sent: probes.length, committed: probes.filter((p) => p.ok).length },
    perSecond,
  };
}

async function main() {
  const results = [];
  for (const ch of CHANNELS) {
    console.log(`E3 on ${ch} (${END}s)`);
    const r = await run(ch);
    console.log(JSON.stringify({ channel: r.channel, phases: r.phases, leaderStop: r.leaderStopToNextCommitS, restart: r.restartToNextCommitS, twoDown: r.twoDownProbes.errorKinds }));
    results.push(r);
    await sleep(20_000);
  }
  writeResult(
    'faults',
    {
      description:
        'Ping from 8 closed-loop workers (10 s commit deadline) plus an independent probe sending one Ping per second (8 s commit deadline) while orderers are stopped and restarted. Recovery times come from the probe.',
      results,
    },
    { device: 'docker-desktop-arm64', workload: 'Ping-x8+probe' },
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
