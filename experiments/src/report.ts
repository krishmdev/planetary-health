// Regenerates experiments/RESULTS.md, the SVG figures, and the README section between
// <!-- experiments:start --> and <!-- experiments:end --> from experiments/results/*.json.
// Every number in the README comes from here.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/manifest.js';

const R = path.join(ROOT, 'experiments/results');
const F = path.join(ROOT, 'experiments/figures');
const load = <T>(name: string): T | null => {
  const f = path.join(R, `${name}.json`);
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as T) : null;
};

// Reference categorical order (validated: scripts/validate_palette.js, light surface).
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'];
const INK = '#0b0b0b';
const INK2 = '#52514e';
const GRID = '#e4e2dc';
const SURFACE = '#fcfcfb';
const FONT = 'font-family="IBM Plex Sans, Helvetica, Arial, sans-serif"';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const fmt = (v: number | null | undefined, d = 0) => (v === null || v === undefined ? 'n/a' : v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }));

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function svg(w: number, h: number, title: string, body: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(title)}" ${FONT}>
<rect width="${w}" height="${h}" fill="${SURFACE}"/>
<text x="16" y="24" font-size="15" font-weight="600" fill="${INK}">${esc(title)}</text>
${body}
</svg>
`;
}

function yAxis(x0: number, x1: number, y0: number, y1: number, max: number, unit: string) {
  let out = '';
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    const y = y0 - ((y0 - y1) * i) / 4;
    out += `<line x1="${x0}" x2="${x1}" y1="${y}" y2="${y}" stroke="${GRID}" stroke-width="1"/>`;
    out += `<text x="${x0 - 6}" y="${y + 4}" font-size="11" text-anchor="end" fill="${INK2}">${fmt(v, v < 10 && v % 1 ? 1 : 0)}${i === 4 ? ` ${unit}` : ''}</text>`;
  }
  return out;
}

// E3: commits per second over time, one line per consensus type, event markers on top.
function faultsFigure(res: FaultsResult): string {
  const W = 760;
  const H = 300;
  const x0 = 56;
  const x1 = W - 20;
  const y0 = H - 40;
  const y1 = 60;
  const end = Math.max(...res.results.map((r) => r.perSecond.length));
  const max = niceMax(Math.max(...res.results.flatMap((r) => r.perSecond.map((p) => p.commits))));
  const X = (t: number) => x0 + ((x1 - x0) * t) / end;
  const Y = (v: number) => y0 - ((y0 - y1) * v) / max;
  let body = yAxis(x0, x1, y0, y1, max, 'commits/s');
  for (let t = 0; t <= end; t += 30) body += `<text x="${X(t)}" y="${y0 + 16}" font-size="11" text-anchor="middle" fill="${INK2}">${t}s</text>`;
  const marks = res.results[0]?.events ?? [];
  for (const e of marks) {
    body += `<line x1="${X(e.t)}" x2="${X(e.t)}" y1="${y1 - 4}" y2="${y0}" stroke="${INK2}" stroke-width="1" stroke-dasharray="3 3"><title>${esc(e.what)}</title></line>`;
  }
  const labels: [number, string][] = [
    [30, 'follower down'],
    [60, 'follower back'],
    [90, 'leader down'],
    [180, '2 of 4 down'],
    [210, 'all restarted'],
  ];
  for (const [t, l] of labels) body += `<text x="${X(t) + 3}" y="${y1 - 8}" font-size="10" fill="${INK2}">${l}</text>`;
  res.results.forEach((r, i) => {
    const pts = r.perSecond.map((p) => `${X(p.t + 0.5).toFixed(1)},${Y(p.commits).toFixed(1)}`).join(' ');
    body += `<polyline points="${pts}" fill="none" stroke="${SERIES[i]}" stroke-width="2" stroke-linejoin="round"><title>${r.consensus}</title></polyline>`;
  });
  // Legend in one row above the plot.
  res.results.forEach((r, i) => {
    const lx = x0 + i * 130;
    body += `<rect x="${lx}" y="36" width="14" height="3" rx="1.5" fill="${SERIES[i]}"/><text x="${lx + 20}" y="41" font-size="12" fill="${INK}">${r.consensus}</text>`;
  });
  return svg(W, H, 'E3: commits per second while orderers fail (8 clients)', body);
}

// Grouped bars for p50 / p95 per mode.
function coldFigure(res: ColdResult): string {
  const W = 760;
  const H = 300;
  const x0 = 64;
  const x1 = W - 20;
  const y0 = H - 44;
  const y1 = 60;
  const rows = res.rows;
  const max = niceMax(Math.max(...rows.map((r) => r.latencyMs.p95 ?? 0)));
  const Y = (v: number) => y0 - ((y0 - y1) * v) / max;
  const band = (x1 - x0) / rows.length;
  const bw = Math.min(46, band / 3);
  let body = yAxis(x0, x1, y0, y1, max, 'ms');
  rows.forEach((r, i) => {
    const cx = x0 + band * i + band / 2;
    (['p50', 'p95'] as const).forEach((k, j) => {
      const v = r.latencyMs[k] ?? 0;
      const x = cx - bw - 1 + j * (bw + 2);
      const y = Y(v);
      body += `<path d="M${x},${y0} V${y + 4} Q${x},${y} ${x + 4},${y} H${x + bw - 4} Q${x + bw},${y} ${x + bw},${y + 4} V${y0} Z" fill="${SERIES[j]}"><title>${r.mode} ${k}: ${fmt(v)} ms</title></path>`;
      body += `<text x="${x + bw / 2}" y="${y - 5}" font-size="11" text-anchor="middle" fill="${INK}">${fmt(v)}</text>`;
    });
    body += `<text x="${cx}" y="${y0 + 18}" font-size="12" text-anchor="middle" fill="${INK}">${r.mode}</text>`;
  });
  body += `<line x1="${x0}" x2="${x1}" y1="${y0}" y2="${y0}" stroke="${INK2}" stroke-width="1"/>`;
  ['p50', 'p95'].forEach((k, j) => {
    body += `<rect x="${x0 + j * 70}" y="34" width="10" height="10" rx="2" fill="${SERIES[j]}"/><text x="${x0 + j * 70 + 16}" y="43" font-size="12" fill="${INK}">${k}</text>`;
  });
  return svg(W, H, `E1: request latency through the activator (n=${rows[0]?.trials ?? '?'} per mode)`, body);
}

// Stacked horizontal bars of memory-time by component group.
function idleFigure(res: IdleResult): string {
  const W = 760;
  const rows = res.summary;
  const groups = ['orderers', 'peers+chaincode', 'apis', 'activator'];
  const H = 110 + rows.length * 44;
  const x0 = 110;
  const x1 = W - 90;
  const max = niceMax(Math.max(...rows.map((r) => r.totalMemGiBSeconds)));
  const X = (v: number) => x0 + ((x1 - x0) * v) / max;
  let body = '';
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    body += `<line x1="${X(v)}" x2="${X(v)}" y1="56" y2="${H - 34}" stroke="${GRID}"/><text x="${X(v)}" y="${H - 18}" font-size="11" text-anchor="middle" fill="${INK2}">${fmt(v)}${i === 4 ? ' GiB·s' : ''}</text>`;
  }
  rows.forEach((r, i) => {
    const y = 64 + i * 44;
    let acc = 0;
    body += `<text x="${x0 - 8}" y="${y + 18}" font-size="12" text-anchor="end" fill="${INK}">${r.mode}</text>`;
    groups.forEach((g, j) => {
      const v = r.memGiBSeconds[g] ?? 0;
      if (v <= 0) return;
      const xa = X(acc);
      const xb = X(acc + v);
      body += `<rect x="${xa + (acc > 0 ? 1 : 0)}" y="${y}" width="${Math.max(0.5, xb - xa - (acc > 0 ? 2 : 0))}" height="28" rx="${j === 0 ? 3 : 0}" fill="${SERIES[j]}"><title>${r.mode} · ${g}: ${fmt(v)} GiB·s</title></rect>`;
      acc += v;
    });
    body += `<text x="${X(acc) + 6}" y="${y + 18}" font-size="12" fill="${INK}">${fmt(r.totalMemGiBSeconds)}${r.memSavedPct ? ` (−${fmt(r.memSavedPct, 1)}%)` : ''}</text>`;
  });
  groups.forEach((g, j) => {
    body += `<rect x="${x0 + j * 150}" y="36" width="10" height="10" rx="2" fill="${SERIES[j]}"/><text x="${x0 + j * 150 + 16}" y="45" font-size="12" fill="${INK}">${g}</text>`;
  });
  return svg(W, H, `E4: memory-time over ${res.config.windowS}s idle (mean of ${res.config.repeats})`, body);
}

interface Summ {
  n: number;
  p50: number | null;
  p95: number | null;
  max?: number | null;
  p99?: number | null;
}
interface ColdResult {
  rows: { mode: string; trials: number; failures: number; coldResponses: number; latencyMs: Summ; activationMs: Summ; startMs: Summ; readyMs: Summ }[];
  fullColdPhiRead: { trials: number; succeeded: number; latencyMs: Summ; statuses: number[] };
}
interface ThroughputResult {
  config: { durationS: number };
  rows: { consensus: string; concurrency: number; tps: number; committed: number; submitToCommitMs: Summ; endorseMs: Summ; errors: Record<string, number> }[];
}
interface FaultsResult {
  results: {
    consensus: string;
    events: { t: number; what: string }[];
    perSecond: { t: number; commits: number; errors: number }[];
    phases: { baselineTps: number; followerDownTps: number; afterLeaderStopTps: number; twoDownCommits: number; recoveredTps: number };
    leaderStopToNextCommitS: number | null;
    restartToNextCommitS: number | null;
    twoDownErrors: { count: number; quorumMessageSeen: boolean };
  }[];
}
interface IdleResult {
  config: { windowS: number; repeats: number };
  summary: { mode: string; totalCpuSeconds: number; totalMemGiBSeconds: number; cpuSavedPct: number; memSavedPct: number; memGiBSeconds: Record<string, number>; cpuSeconds: Record<string, number>; perRepeatTotalMem: number[] }[];
}
interface E2EResult {
  ran_at: string;
  passed: number;
  failed: number;
  steps: { name: string; ok: boolean }[];
}

function main() {
  fs.mkdirSync(F, { recursive: true });
  const cold = load<ColdResult>('coldstart');
  const thr = load<ThroughputResult>('throughput');
  const faults = load<FaultsResult>('faults');
  const idle = load<IdleResult>('idle');
  const e2e = load<E2EResult>('e2e');
  const md: string[] = [];

  md.push('| Experiment | Configuration | Metric | Result |', '|---|---|---|---|');
  if (cold) {
    for (const r of cold.rows) md.push(`| E1 cold start | ${r.mode} (n=${r.latencyMs.n}) | p50 / ${r.latencyMs.n < 20 ? 'max' : 'p95'} latency | ${fmt(r.latencyMs.p50)} / ${fmt(r.latencyMs.n < 20 ? r.latencyMs.max : r.latencyMs.p95)} ms |`);
    const p = cold.fullColdPhiRead;
    md.push(`| E1 cold start | PHI read after both orgs idle | p50 latency, successes | ${fmt(p.latencyMs.p50)} ms, ${p.succeeded}/${p.trials} |`);
  } else md.push('| E1 cold start | | | not run |');
  if (thr) {
    for (const c of [1, 8, 32, 64]) {
      const b = thr.rows.find((r) => r.consensus === 'SmartBFT' && r.concurrency === c);
      const f = thr.rows.find((r) => r.consensus === 'etcdraft' && r.concurrency === c);
      if (b && f)
        md.push(`| E2 throughput | ${c} clients, BFT vs Raft | TPS; commit p50 | ${fmt(b.tps, 1)} vs ${fmt(f.tps, 1)} TPS; ${fmt(b.submitToCommitMs.p50)} vs ${fmt(f.submitToCommitMs.p50)} ms |`);
    }
  } else md.push('| E2 throughput | | | not run |');
  if (faults) {
    for (const r of faults.results) {
      md.push(
        `| E3 faults | ${r.consensus}: follower down / leader down / 2 of 4 down | TPS; time to next commit; commits | ${fmt(r.phases.followerDownTps, 1)} TPS; ${fmt(r.leaderStopToNextCommitS, 1)} s; ${r.phases.twoDownCommits}${r.twoDownErrors.quorumMessageSeen ? ' (quorum error)' : ''} |`,
      );
    }
  } else md.push('| E3 faults | | | not run |');
  if (idle) {
    for (const r of idle.summary)
      md.push(`| E4 idle cost | ${r.mode}, ${idle.config.windowS}s × ${idle.config.repeats} repeats${idle.config.repeats < 3 ? ' (plan: 3)' : ''} | CPU-s; GiB·s (saved); per repeat | ${fmt(r.totalCpuSeconds, 1)}; ${fmt(r.totalMemGiBSeconds)} (${fmt(r.memSavedPct, 1)}%); ${r.perRepeatTotalMem.join(' / ')} |`);
  } else md.push('| E4 idle cost | | | not run |');
  if (e2e) md.push(`| e2e | live network, host gateways | checks passed | ${e2e.passed}/${e2e.passed + e2e.failed} |`);

  const figures: string[] = [];
  if (cold) {
    fs.writeFileSync(path.join(F, 'coldstart.svg'), coldFigure(cold));
    figures.push('![E1 cold start](experiments/figures/coldstart.svg)');
  }
  if (faults) {
    fs.writeFileSync(path.join(F, 'faults.svg'), faultsFigure(faults));
    figures.push('![E3 fault timeline](experiments/figures/faults.svg)');
  }
  if (idle) {
    fs.writeFileSync(path.join(F, 'idle.svg'), idleFigure(idle));
    figures.push('![E4 idle memory-time](experiments/figures/idle.svg)');
  }

  // Full detail for experiments/RESULTS.md.
  const detail: string[] = ['# Experiment results', '', 'Generated by `pnpm -C experiments report` from `experiments/results/*.json`; each file embeds its run manifest (host, docker ps, top processes, compute-lease holder).', ''];
  if (cold) {
    detail.push('## E1 cold vs warm', '', 'p95 is nearest-rank, so for n < 20 it equals the maximum.', '', '| Mode | n | p50 ms | p95 ms | activation p50 ms (start / ready) | failures |', '|---|---|---|---|---|---|');
    for (const r of cold.rows)
      detail.push(`| ${r.mode} | ${r.latencyMs.n} | ${fmt(r.latencyMs.p50)} | ${fmt(r.latencyMs.p95)} | ${fmt(r.activationMs.p50)} (${fmt(r.startMs.p50)} / ${fmt(r.readyMs.p50)}) | ${r.failures} |`);
    detail.push('', `PHI read (grant submit + delivery) as the first request after both orgs idled: ${cold.fullColdPhiRead.succeeded}/${cold.fullColdPhiRead.trials} succeeded, statuses ${cold.fullColdPhiRead.statuses.join(', ')}, p50 ${fmt(cold.fullColdPhiRead.latencyMs.p50)} ms.`, '');
  }
  if (thr) {
    detail.push('## E2 throughput', '', `Closed loop for ${thr.config.durationS}s per level.`, '', '| Consensus | Clients | TPS | committed | endorse p50 ms | commit p50 / p95 / p99 ms | errors |', '|---|---|---|---|---|---|---|');
    for (const r of thr.rows)
      detail.push(`| ${r.consensus} | ${r.concurrency} | ${fmt(r.tps, 1)} | ${r.committed} | ${fmt(r.endorseMs.p50)} | ${fmt(r.submitToCommitMs.p50)} / ${fmt(r.submitToCommitMs.p95)} / ${fmt(r.submitToCommitMs.p99)} | ${Object.entries(r.errors).map(([k, v]) => `${k}:${v}`).join(' ') || '0'} |`);
    detail.push('');
  }
  if (faults) {
    detail.push('## E3 faults', '', '| Consensus | baseline TPS | follower down TPS | leader stop → next commit | after leader stop TPS | commits with 2 down | quorum error seen | restart → next commit | recovered TPS |', '|---|---|---|---|---|---|---|---|---|');
    for (const r of faults.results)
      detail.push(`| ${r.consensus} | ${fmt(r.phases.baselineTps, 1)} | ${fmt(r.phases.followerDownTps, 1)} | ${fmt(r.leaderStopToNextCommitS, 1)} s | ${fmt(r.phases.afterLeaderStopTps, 1)} | ${r.phases.twoDownCommits} | ${r.twoDownErrors.quorumMessageSeen ? 'yes' : 'no'} | ${fmt(r.restartToNextCommitS, 1)} s | ${fmt(r.phases.recoveredTps, 1)} |`);
    detail.push('');
  }
  if (idle) {
    const groups = ['orderers', 'peers+chaincode', 'apis', 'activator'];
    detail.push('## E4 idle cost', '', `In s2z-full the APIs stop after ${(idle.config as { apiIdleTimeoutS?: number }).apiIdleTimeoutS ?? 60} s and the peers after about ${(idle.config as { peerIdleTimeoutS?: number }).peerIdleTimeoutS ?? 300} s, so the peers sleep for roughly the second half of the ${idle.config.windowS} s window.`, '', `| Mode | CPU-s | GiB·s | ${groups.map((g) => `${g} GiB·s`).join(' | ')} | per-repeat GiB·s | saved (CPU / mem) |`, `|---|---|---|${groups.map(() => '---').join('|')}|---|---|`);
    for (const r of idle.summary)
      detail.push(`| ${r.mode} | ${fmt(r.totalCpuSeconds, 1)} | ${fmt(r.totalMemGiBSeconds)} | ${groups.map((g) => fmt(r.memGiBSeconds[g])).join(' | ')} | ${r.perRepeatTotalMem.join(', ')} | ${fmt(r.cpuSavedPct, 1)}% / ${fmt(r.memSavedPct, 1)}% |`);
    detail.push('');
  }
  if (e2e) {
    detail.push('## e2e', '', `Run ${e2e.ran_at}: ${e2e.passed} passed, ${e2e.failed} failed.`, '', ...e2e.steps.map((s) => `- ${s.ok ? 'PASS' : 'FAIL'} ${s.name}`), '');
  }
  fs.writeFileSync(path.join(ROOT, 'experiments/RESULTS.md'), detail.join('\n'));

  const readme = path.join(ROOT, 'README.md');
  if (fs.existsSync(readme)) {
    const text = fs.readFileSync(readme, 'utf8');
    const block = ['<!-- experiments:start -->', ...md, '', ...figures.flatMap((f) => [f, '']), 'Full tables: [experiments/RESULTS.md](experiments/RESULTS.md).', '<!-- experiments:end -->'].join('\n');
    const next = text.replace(/<!-- experiments:start -->[\s\S]*<!-- experiments:end -->/, block);
    fs.writeFileSync(readme, next);
  }
  console.log(md.join('\n'));
}

main();
