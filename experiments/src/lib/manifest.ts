import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '../../..');
// Optional host-state recorder; set RUN_MANIFEST to its path to embed a manifest in each result.
const TOOL = process.env.RUN_MANIFEST ?? '';

// Host and workload state at the time of a run (lease holder, docker ps, top processes...).
export function runManifest(extra: Record<string, string>): unknown {
  if (!TOOL || !fs.existsSync(TOOL)) return { note: 'RUN_MANIFEST not set; no host manifest recorded', extra };
  const args = [TOOL, ...Object.entries(extra).map(([k, v]) => `${k}=${v}`)];
  return JSON.parse(execFileSync('python3', args, { encoding: 'utf8' }));
}

export function writeResult(name: string, data: object, extra: Record<string, string>) {
  const file = path.join(ROOT, 'experiments/results', `${name}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const out = { experiment: name, ...data, run_manifest: runManifest({ experiment: name, ...extra }) };
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${path.relative(ROOT, file)}`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
