// E3: faults under steady load (8 closed-loop clients), for each channel:
//   t=30s  stop a follower orderer, restart it at t=60s
//   t=90s  stop the current leader; record the time to the next commit
//   t=180s stop a second orderer (two down): expect no commits and, for BFT, the gateway's
//          quorum error
//   t=210s restart everything, t=240s end
// Output: commits per second and error counts per second, plus a summary per phase.
//
//   pnpm -C experiments faults [--channels ehrchannel,ehrraft] [--scale 1]
import { docker } from './lib/docker.js';
import { connectAs, leaderOf, ORDERERS } from './lib/fabric.js';
import { sleep, writeResult } from './lib/manifest.js';

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : dflt;
};
const CHANNELS = arg('channels', 'ehrchannel,ehrraft').split(',');
const END = 240;

interface Event {
  t: number;
  what: string;
}

async function run(channel: string) {
  const bft = channel === 'ehrchannel';
  const conn = connectAs('org1', 'drchen', channel, 120_000);
  const commitsAt: number[] = [];
  const errorsAt: { t: number; msg: string }[] = [];
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
        const e = err as { message?: string; details?: { message: string }[] };
        errorsAt.push({ t: now(), msg: [e.message, ...(e.details ?? []).map((d) => d.message)].join(' | ').slice(0, 300) });
        await sleep(250);
      }
    }
  };
  const workers = Array.from({ length: 8 }, worker);

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
  await Promise.race([Promise.all(workers), sleep(130_000)]);
  conn.close();

  const perSecond = Array.from({ length: END }, (_, s) => ({
    t: s,
    commits: commitsAt.filter((c) => c >= s && c < s + 1).length,
    errors: errorsAt.filter((e) => e.t >= s && e.t < s + 1).length,
  }));
  const firstAfter = (t: number) => commitsAt.filter((c) => c > t).sort((a, b) => a - b)[0];
  const tps = (a: number, b: number) => Math.round((commitsAt.filter((c) => c >= a && c < b).length / (b - a)) * 10) / 10;
  const quorumErrors = errorsAt.filter((e) => e.t >= twoDownAt && e.t < restartedAt);
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
      recoveredTps: tps(restartedAt + 10, END),
    },
    leaderStopToNextCommitS: (() => {
      const f = firstAfter(leaderStoppedAt);
      return f === undefined ? null : Math.round((f - leaderStoppedAt) * 10) / 10;
    })(),
    restartToNextCommitS: (() => {
      const f = firstAfter(restartedAt);
      return f === undefined ? null : Math.round((f - restartedAt) * 10) / 10;
    })(),
    twoDownErrors: {
      count: quorumErrors.length,
      quorumMessageSeen: quorumErrors.some((e) => e.msg.includes('insufficient number of orderers')),
      sample: quorumErrors.slice(0, 3).map((e) => e.msg),
    },
    perSecond,
  };
}

async function main() {
  const results = [];
  for (const ch of CHANNELS) {
    console.log(`E3 on ${ch} (${END}s)`);
    const r = await run(ch);
    console.log(JSON.stringify({ channel: r.channel, phases: r.phases, leaderStop: r.leaderStopToNextCommitS, quorum: r.twoDownErrors.quorumMessageSeen }));
    results.push(r);
    // Let the restarted orderers settle before the next channel.
    await sleep(20_000);
  }
  writeResult(
    'faults',
    { description: 'Ping transactions from 8 closed-loop clients while orderers are stopped and restarted.', results },
    { device: 'docker-desktop-arm64', workload: 'Ping-x8' },
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
