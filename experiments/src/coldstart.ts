// E1: latency of the same request (GET /patients/P-1001/records as Alice, which reaches the
// chaincode) through the activator in four states:
//   warm         everything running (always_on)
//   resume       org1-api paused, unpaused on demand (pause strategy)
//   api-cold     org1-api stopped, started on demand
//   full-cold    org1-api, both peers and their chaincode containers stopped (s2z-full)
// Also one "PHI read after both orgs idle" in full mode (grant submit + delivery evaluate).
//
//   pnpm -C experiments coldstart [--n 20]
import { ORG1_API, scaleDown, Session, setMode } from './lib/app.js';
import { sleep, writeResult } from './lib/manifest.js';
import { summary } from './lib/stats.js';

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : dflt;
};
const N = Number(arg('n', '20'));
const PATH = '/patients/P-1001/records';

type Trial = Awaited<ReturnType<Session['timed']>>;

function breakdown(trials: Trial[]) {
  const parse = (b: string | null, k: string) => {
    const m = b ? new RegExp(`${k}=(\\d+)`).exec(b) : null;
    return m ? Number(m[1]) : null;
  };
  const start = trials.map((t) => parse(t.breakdown, 'start')).filter((v): v is number => v !== null);
  const ready = trials.map((t) => parse(t.breakdown, 'ready')).filter((v): v is number => v !== null);
  return { startMs: summary(start), readyMs: summary(ready) };
}

async function mode(name: string, prepare: () => Promise<void>, alice: Session) {
  const trials: Trial[] = [];
  for (let i = 0; i < N; i++) {
    await alice.ensure();
    await prepare();
    const t = await alice.timed('GET', PATH);
    if (t.status !== 200) console.warn(`${name} trial ${i}: HTTP ${t.status} ${t.body.slice(0, 200)}`);
    trials.push(t);
    process.stdout.write(`${name} ${i + 1}/${N}: ${Math.round(t.ms)} ms${t.cold ? ' (cold)' : ''}\n`);
    await sleep(300);
  }
  const ok = trials.filter((t) => t.status === 200);
  return {
    mode: name,
    trials: trials.length,
    failures: trials.length - ok.length,
    coldResponses: ok.filter((t) => t.cold).length,
    latencyMs: summary(ok.map((t) => t.ms)),
    activationMs: summary(ok.map((t) => t.activationMs).filter((v): v is number => v !== null)),
    ...breakdown(ok),
    samplesMs: trials.map((t) => Math.round(t.ms)),
  };
}

async function main() {
  const alice = new Session(ORG1_API, 'alice');
  const doctor = new Session(ORG1_API, 'drchen');
  const rows = [];

  await setMode('always_on', 'stop');
  await alice.ensure();
  await alice.timed('GET', PATH);
  rows.push(await mode('warm', async () => undefined, alice));

  await setMode('api', 'pause');
  rows.push(await mode('resume', () => scaleDown('org1-api').then(() => undefined), alice));

  await setMode('api', 'stop');
  rows.push(await mode('api-cold', () => scaleDown('org1-api').then(() => undefined), alice));

  await setMode('full', 'stop');
  rows.push(
    await mode(
      'full-cold',
      async () => {
        await scaleDown('org1-api');
        await scaleDown('org2-api');
        await scaleDown('ehrchannel');
      },
      alice,
    ),
  );

  // Contract test from the plan: both orgs idle, then the first request is a PHI read (a
  // MAJORITY-endorsed grant submit followed by the delivery evaluate).
  await doctor.ensure();
  const recs = JSON.parse((await doctor.timed('GET', PATH)).body) as { recordId: string; type: string }[];
  const lab = recs.find((r) => r.type === 'lab');
  const phiTrials = [];
  for (let i = 0; i < Math.min(N, 5); i++) {
    await doctor.ensure();
    await scaleDown('org1-api');
    await scaleDown('org2-api');
    await scaleDown('ehrchannel');
    const t = await doctor.timed('POST', `/records/${lab?.recordId}/read`, { purpose: 'cold PHI read' });
    phiTrials.push(t);
    console.log(`full-cold PHI read ${i + 1}: ${t.status} ${Math.round(t.ms)} ms`);
  }
  await setMode('always_on', 'stop');

  writeResult(
    'coldstart',
    {
      description: `GET ${PATH} as Alice through the activator; ${N} trials per mode. Login happens before scale-down.`,
      rows,
      fullColdPhiRead: {
        trials: phiTrials.length,
        succeeded: phiTrials.filter((t) => t.status === 200).length,
        latencyMs: summary(phiTrials.filter((t) => t.status === 200).map((t) => t.ms)),
        statuses: phiTrials.map((t) => t.status),
      },
    },
    { device: 'docker-desktop-arm64', request: PATH, n: String(N) },
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
