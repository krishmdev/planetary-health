// BFT fault demo on ehrchannel (4 SmartBFT orderers, f = 1):
//   1. baseline transaction
//   2. stop a follower, submit: still commits (3 of 4); restart it
//   3. stop the leader and time the first commit after the view change
//   4. stop a second orderer (2 of 4 down): the gateway returns the quorum error
//   5. restart everything and show recovery
// Writes experiments/results/bft-demo.json and docs/bft-demo.md.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { docker } from './lib/docker.js';
import { connectAs, leaderOf, ORDERERS } from './lib/fabric.js';
import { ROOT, sleep, writeResult } from './lib/manifest.js';

interface Step {
  step: string;
  outcome: string;
  ms: number;
  block?: string;
  error?: string;
}

async function main() {
  const conn = connectAs('org1', 'drchen', 'ehrchannel', 120_000);
  const steps: Step[] = [];
  const submit = async (label: string): Promise<Step> => {
    const t0 = performance.now();
    try {
      const sub = await conn.contract.submitAsync('Ping');
      const st = await sub.getStatus();
      const s = { step: label, outcome: st.successful ? 'committed' : `invalid (${st.code})`, ms: Math.round(performance.now() - t0), block: st.blockNumber.toString() };
      steps.push(s);
      return s;
    } catch (err) {
      const e = err as { message?: string; details?: { message: string }[] };
      const s = { step: label, outcome: 'failed', ms: Math.round(performance.now() - t0), error: [e.message, ...(e.details ?? []).map((d) => d.message)].join(' | ').slice(0, 400) };
      steps.push(s);
      return s;
    }
  };
  const log = (s: Step) => console.log(`${s.step}: ${s.outcome} in ${s.ms} ms${s.block ? ` (block ${s.block})` : ''}${s.error ? ` - ${s.error}` : ''}`);

  log(await submit('baseline, 4 of 4 orderers up'));
  const leader = (await leaderOf('ehrchannel', true)) ?? ORDERERS[0]!;
  const follower = ORDERERS.find((o) => o.name !== leader.name)!;
  console.log(`leader is orderer id ${leader.id} (${leader.name})`);

  await docker.stop(follower.name, 2);
  log(await submit(`follower ${follower.name} stopped, 3 of 4 up`));
  await docker.start(follower.name);
  // A view change needs the restarted follower's vote, so don't stop the leader until the
  // follower has caught up to the other orderers' height.
  const heights = async () =>
    Promise.all(
      ORDERERS.map(async (o) => {
        try {
          const t = await (await fetch(`${o.ops}/metrics`, { signal: AbortSignal.timeout(1500) })).text();
          const line = t.split('\n').find((l) => l.startsWith('ledger_blockchain_height{channel="ehrchannel"}'));
          return line ? Number(line.split(/\s+/).pop()) : -1;
        } catch {
          return -1;
        }
      }),
    );
  const restartedFollowerAt = performance.now();
  let caughtUp: number[] = [];
  for (let i = 0; i < 120; i++) {
    caughtUp = await heights();
    if (caughtUp.every((h) => h > 0 && h === caughtUp[0])) break;
    await sleep(1000);
  }
  const followerCatchUpS = Math.round((performance.now() - restartedFollowerAt) / 100) / 10;
  console.log(`orderer heights ${caughtUp.join(',')} after ${followerCatchUpS}s`);
  log(await submit('follower restarted and caught up, 4 of 4 up'));

  const logsSince = new Date().toISOString();
  await docker.stop(leader.name, 2);
  const leaderStopped = performance.now();
  let first: Step | null = null;
  for (let i = 0; i < 20 && !first; i++) {
    const s = await submit(`leader ${leader.name} stopped, attempt ${i + 1}`);
    log(s);
    if (s.outcome === 'committed') first = s;
  }
  const viewChangeS = first ? Math.round((performance.now() - leaderStopped) / 100) / 10 : null;
  const newLeader = await leaderOf('ehrchannel', true, [leader.name]);
  console.log(`first commit ${viewChangeS}s after stopping the leader; new leader ${newLeader?.name ?? 'unknown'}`);

  // Orderer log lines about the view change, for the record.
  const viewChangeLog = ORDERERS.filter((o) => o.name !== leader.name).flatMap((o) => {
    try {
      const out = execFileSync('docker', ['logs', '--since', logsSince, o.name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
      return out
        .replace(/\x1b\[[0-9;]*m/g, '')
        .split('\n')
        .filter((l) => /view ?change|ViewChange|complain|new leader|leader.*(changed|is)|heartbeat/i.test(l))
        .slice(0, 12)
        .map((l) => `${o.name}: ${l.slice(0, 240)}`);
    } catch {
      return [];
    }
  });

  const second = ORDERERS.find((o) => o.name !== leader.name && o.name !== newLeader?.name)!;
  await docker.stop(second.name, 2);
  const quorum = await submit(`second orderer ${second.name} stopped, 2 of 4 up`);
  log(quorum);

  await docker.start(leader.name);
  await docker.start(second.name);
  const restarted = performance.now();
  let recovered: Step | null = null;
  for (let i = 0; i < 20 && !recovered; i++) {
    const s = await submit(`all restarted, attempt ${i + 1}`);
    log(s);
    if (s.outcome === 'committed') recovered = s;
    else await sleep(2000);
  }
  const recoveryS = recovered ? Math.round((performance.now() - restarted) / 100) / 10 : null;
  conn.close();

  const summary = {
    leaderBefore: leader.name,
    leaderAfter: newLeader?.name ?? null,
    followerCatchUpS,
    heightsBeforeLeaderStop: caughtUp,
    leaderStopToFirstCommitS: viewChangeS,
    twoDownQuorumError: quorum.outcome === 'failed' && (quorum.error ?? '').includes('insufficient number of orderers'),
    twoDownError: quorum.error ?? null,
    restartToFirstCommitS: recoveryS,
  };
  writeResult('bft-demo', { summary, steps, viewChangeLog }, { device: 'docker-desktop-arm64' });

  const md = [
    '# BFT fault demo',
    '',
    'Generated by `make bft-demo` (`experiments/src/bftDemo.ts`) from `experiments/results/bft-demo.json`. Each step submits a `Ping` transaction through Org1\'s gateway service. The gateway sends it to all four orderers; three must accept (`ceil((n+f+1)/2)` with n=4, f=1).',
    '',
    '| Step | Outcome | Time (ms) | Block |',
    '|---|---|---|---|',
    ...steps.map((s) => `| ${s.step} | ${s.outcome} | ${s.ms} | ${s.block ?? ''} |`),
    '',
    `- Leader before: \`${summary.leaderBefore}\`, after the view change: \`${summary.leaderAfter ?? 'unknown'}\`.`,
    `- The leader was stopped only after the restarted follower had caught up (all four orderers at height ${caughtUp.join('/')}, ${followerCatchUpS} s after its restart).`,
    `- First commit after stopping the leader: ${summary.leaderStopToFirstCommitS ?? 'none'} s. The channel uses RequestComplainTimeout 20s, ViewChangeTimeout 20s and LeaderHeartbeatTimeout 1m.`,
    `- With two orderers down the gateway returned: \`${(summary.twoDownError ?? 'no error').replace(/\|/g, '/')}\``,
    `- After restarting both, the first commit came ${summary.restartToFirstCommitS ?? 'never'} s later.`,
    '',
    '## Orderer log lines around the view change',
    '',
    '```',
    ...(viewChangeLog.length ? viewChangeLog : ['(no matching lines)']),
    '```',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(ROOT, 'docs/bft-demo.md'), md);
  console.log('wrote docs/bft-demo.md');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
