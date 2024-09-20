import http from 'node:http';

// Docker Engine API over the unix socket (for stats, fault injection and scale-down).
const SOCKET = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock';

function call<T>(method: string, path: string, timeoutMs = 60_000): Promise<{ status: number; body: T }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCKET, path: `/v1.43${path}`, method, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown = text;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          // plain text
        }
        resolve({ status: res.statusCode ?? 0, body: body as T });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`docker ${method} ${path} timed out`)));
    req.on('error', reject);
    req.end();
  });
}

async function ok(method: string, path: string, codes: number[]) {
  const r = await call(method, path);
  if (!codes.includes(r.status)) throw new Error(`docker ${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
}

export const docker = {
  start: (n: string) => ok('POST', `/containers/${n}/start`, [204, 304]),
  stop: (n: string, t = 10) => ok('POST', `/containers/${n}/stop?t=${t}`, [204, 304, 404]),
  kill: (n: string) => ok('POST', `/containers/${n}/kill`, [204, 409]),
  pause: (n: string) => ok('POST', `/containers/${n}/pause`, [204]),
  unpause: (n: string) => ok('POST', `/containers/${n}/unpause`, [204]),
  async state(n: string): Promise<string> {
    const r = await call<{ State?: { Status: string } }>('GET', `/containers/${n}/json`);
    return r.status === 404 ? 'missing' : (r.body.State?.Status ?? 'unknown');
  },
  async list(filterName?: string): Promise<string[]> {
    const f = filterName ? `&filters=${encodeURIComponent(JSON.stringify({ name: [filterName] }))}` : '';
    const r = await call<{ Names: string[] }[]>('GET', `/containers/json?all=true${f}`);
    return r.body.flatMap((c) => c.Names.map((n) => n.replace(/^\//, '')));
  },
  async running(): Promise<string[]> {
    const r = await call<{ Names: string[] }[]>('GET', `/containers/json`);
    return r.body.flatMap((c) => c.Names.map((n) => n.replace(/^\//, '')));
  },
  async stats(n: string): Promise<Stats | null> {
    const r = await call<RawStats>('GET', `/containers/${n}/stats?stream=false&one-shot=true`, 15_000);
    if (r.status !== 200 || !r.body?.cpu_stats) return null;
    const mem = r.body.memory_stats ?? {};
    const inactive = mem.stats?.inactive_file ?? mem.stats?.total_inactive_file ?? 0;
    return {
      cpuNs: r.body.cpu_stats.cpu_usage?.total_usage ?? 0,
      memBytes: Math.max(0, (mem.usage ?? 0) - inactive),
      running: (r.body.pids_stats?.current ?? 0) > 0,
    };
  },
};

interface RawStats {
  cpu_stats: { cpu_usage?: { total_usage: number } };
  memory_stats?: { usage?: number; stats?: { inactive_file?: number; total_inactive_file?: number } };
  pids_stats?: { current?: number };
}

export interface Stats {
  cpuNs: number;
  memBytes: number;
  running: boolean;
}
