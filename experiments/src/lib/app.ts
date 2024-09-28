import { sleep } from './manifest.js';

// Talking to the app tier through the activator, as a client would.
export const ACTIVATOR = process.env.ACTIVATOR_ADMIN ?? 'http://localhost:8090';
export const ORG1_API = process.env.ORG1_API ?? 'http://localhost:8080';

export async function admin(path: string, method = 'POST'): Promise<unknown> {
  const r = await fetch(`${ACTIVATOR}${path}`, {
    method,
    headers: { 'X-Activator-Token': process.env.ACTIVATOR_ADMIN_TOKEN ?? '' },
    signal: AbortSignal.timeout(180_000),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`activator ${path}: ${r.status} ${JSON.stringify(body)}`);
  return body;
}

export async function setMode(mode: 'always_on' | 'api' | 'full', strategy: 'stop' | 'pause' = 'stop') {
  return admin(`/_activator/mode?mode=${mode}&strategy=${strategy}`);
}

export async function scaleDown(unit: string) {
  for (let i = 0; i < 20; i++) {
    try {
      return await admin(`/_activator/scale-down?unit=${unit}`);
    } catch (err) {
      if (!String(err).includes('in flight')) throw err;
      await sleep(250);
    }
  }
  throw new Error(`scale-down ${unit} kept failing`);
}

export class Session {
  token = '';
  at = 0;

  constructor(
    readonly base: string,
    readonly user: string,
  ) {}

  // Log in while the API is awake, so the measured request is not also paying for login.
  async ensure(): Promise<void> {
    if (this.token && Date.now() - this.at < 10 * 60 * 1000) return;
    const r = await fetch(`${this.base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: this.user, password: `${this.user}-demo` }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!r.ok) throw new Error(`login ${this.user}: ${r.status} ${await r.text()}`);
    this.token = ((await r.json()) as { token: string }).token;
    this.at = Date.now();
  }

  async timed(method: string, path: string, body?: unknown) {
    const t0 = performance.now();
    const r = await fetch(`${this.base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    const text = await r.text();
    const ms = performance.now() - t0;
    return {
      ms,
      status: r.status,
      cold: r.headers.get('x-cold-start') === 'true',
      activationMs: r.headers.get('x-activation-ms') ? Number(r.headers.get('x-activation-ms')) : null,
      breakdown: r.headers.get('x-activation-breakdown'),
      body: text,
    };
  }
}
