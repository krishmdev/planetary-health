// E4: idle resource cost. After one warm-up request, no traffic for a fixed window while every
// relevant container is sampled every 2 s through the Docker stats API.
//   always-on   activator in always_on mode
//   s2z-api     APIs stop after idle_timeout (60 s)
//   s2z-full    APIs after 60 s, peers + chaincode after peer_idle_timeout (300 s)
// CPU-seconds come from positive deltas of cpu_stats.cpu_usage.total_usage (a restart resets
// the counter); memory is (usage - inactive_file) integrated over time, in GiB*s.
//
//   pnpm -C experiments idle [--window 600] [--repeats 3]
import { ORG1_API, Session, setMode } from './lib/app.js';
import { docker } from './lib/docker.js';
import { sleep, writeResult } from './lib/manifest.js';

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : dflt;
};
const WINDOW_S = Number(arg('window', '600'));
const REPEATS = Number(arg('repeats', '3'));
const INTERVAL_MS = 2000;

const GROUPS: Record<string, (name: string) => boolean> = {
  orderers: (n) => /^orderer\d?\.example\.com$/.test(n),
  'peers+chaincode': (n) => /^peer0\.org[12]\.example\.com$/.test(n) || /^dev-peer0\.org[12]\.example\.com-ehr/.test(n),
  apis: (n) => /^planetary-org[12]-api$/.test(n),
  activator: (n) => n === 'planetary-activator',
};

async function containers(): Promise<string[]> {
  const all = await docker.list();
  return all.filter((n) => Object.values(GROUPS).some((g) => g(n)));
}

async function measure(windowS: number) {
  const names = await containers();
  const last = new Map<string, number>();
  const cpuS: Record<string, number> = {};
  const memGiBs: Record<string, number> = {};
  const runningSamples: Record<string, number> = {};
  const series: { t: number; memGiB: Record<string, number>; running: Record<string, number> }[] = [];
  const t0 = Date.now();
  let prevT = t0;
  while (Date.now() - t0 < windowS * 1000) {
    const tick = Date.now();
    const stats = await Promise.all(names.map(async (n) => [n, await docker.stats(n).catch(() => null)] as const));
    const now = Date.now();
    const dt = (now - prevT) / 1000;
    prevT = now;
    const memNow: Record<string, number> = {};
    const runNow: Record<string, number> = {};
    for (const [n, s] of stats) {
      const group = Object.keys(GROUPS).find((g) => GROUPS[g]!(n))!;
      memNow[group] ??= 0;
      runNow[group] ??= 0;
      if (!s || !s.running) continue;
      const prev = last.get(n);
      // A counter lower than before means the container restarted; count from zero.
      const delta = prev === undefined ? 0 : s.cpuNs >= prev ? s.cpuNs - prev : s.cpuNs;
      last.set(n, s.cpuNs);
      cpuS[group] = (cpuS[group] ?? 0) + delta / 1e9;
      const gib = s.memBytes / 2 ** 30;
      memGiBs[group] = (memGiBs[group] ?? 0) + gib * dt;
      memNow[group] += gib;
      runNow[group] += 1;
      runningSamples[n] = (runningSamples[n] ?? 0) + 1;
    }
    series.push({ t: Math.round((now - t0) / 1000), memGiB: memNow, running: runNow });
    const wait = INTERVAL_MS - (Date.now() - tick);
    if (wait > 0) await sleep(wait);
  }
  const round = (o: Record<string, number>): Record<string, number> => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 100) / 100]));
  return { containers: names, cpuSeconds: round(cpuS), memGiBSeconds: round(memGiBs), series };
}

async function warm(mode: 'always_on' | 'api' | 'full', alice: Session) {
  await setMode(mode === 'always_on' ? 'always_on' : mode, 'stop');
  // Start each repeat from the same state: everything awake and used once.
  await alice.ensure();
  const r = await alice.timed('GET', '/patients/P-1001/records');
  if (r.status !== 200) throw new Error(`warm-up failed: ${r.status}`);
}

async function main() {
  const alice = new Session(ORG1_API, 'alice');
  // The read replica is an e2e fixture, not part of either deployment; keep it out of the numbers.
  await docker.stop('peer1.org1.example.com', 5).catch(() => undefined);
  const modes = [
    { name: 'always-on', mode: 'always_on' as const },
    { name: 's2z-api', mode: 'api' as const },
    { name: 's2z-full', mode: 'full' as const },
  ];
  const runs: ({ mode: string; repeat: number } & Awaited<ReturnType<typeof measure>>)[] = [];
  for (let rep = 0; rep < REPEATS; rep++) {
    for (const m of modes) {
      await warm(m.mode, alice);
      console.log(`E4 ${m.name} repeat ${rep + 1}/${REPEATS}: ${WINDOW_S}s idle`);
      const r = await measure(WINDOW_S);
      console.log(`  cpu-s ${JSON.stringify(r.cpuSeconds)} GiB*s ${JSON.stringify(r.memGiBSeconds)}`);
      runs.push({ mode: m.name, repeat: rep + 1, ...r });
    }
  }
  await setMode('always_on', 'stop');

  const groups = Object.keys(GROUPS);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const byMode = modes.map((m) => {
    const rs = runs.filter((r) => r.mode === m.name);
    const cpu = Object.fromEntries(groups.map((g) => [g, Math.round(mean(rs.map((r) => r.cpuSeconds[g] ?? 0)) * 100) / 100]));
    const mem = Object.fromEntries(groups.map((g) => [g, Math.round(mean(rs.map((r) => r.memGiBSeconds[g] ?? 0)) * 100) / 100]));
    const totalCpu = mean(rs.map((r) => Object.values(r.cpuSeconds).reduce((a: number, b: number) => a + b, 0)));
    const totalMem = mean(rs.map((r) => Object.values(r.memGiBSeconds).reduce((a: number, b: number) => a + b, 0)));
    const perRepeatTotalMem = rs.map((r) => Math.round(Object.values(r.memGiBSeconds).reduce((a: number, b: number) => a + b, 0) * 10) / 10);
    return { mode: m.name, cpuSeconds: cpu, memGiBSeconds: mem, totalCpuSeconds: Math.round(totalCpu * 10) / 10, totalMemGiBSeconds: Math.round(totalMem * 10) / 10, perRepeatTotalMem };
  });
  const base = byMode[0]!;
  const summaryRows = byMode.map((m) => ({
    ...m,
    cpuSavedPct: Math.round((1 - m.totalCpuSeconds / base.totalCpuSeconds) * 1000) / 10,
    memSavedPct: Math.round((1 - m.totalMemGiBSeconds / base.totalMemGiBSeconds) * 1000) / 10,
  }));
  writeResult(
    'idle',
    {
      description: `${WINDOW_S}s with no traffic after one warm-up request, ${REPEATS} repeats per mode, Docker stats every ${INTERVAL_MS / 1000}s.`,
      config: { windowS: WINDOW_S, repeats: REPEATS, apiIdleTimeoutS: 60, peerIdleTimeoutS: 300, excluded: ['CAs', 'ui (static nginx)', 'peer1.org1 read replica (stopped)', 'Docker Desktop VM overhead'] },
      summary: summaryRows,
      runs: runs.map((r) => ({ ...r, series: r.series.filter((_, i) => i % 5 === 0) })),
    },
    { device: 'docker-desktop-arm64', window_s: String(WINDOW_S), repeats: String(REPEATS) },
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
