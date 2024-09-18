// End-to-end checks against the running network and gateways. Each step asserts on real HTTP
// responses; the run is written to experiments/results/e2e.json.
//
//   ORG1_URL=http://localhost:8080 ORG2_URL=http://localhost:8081 REPLICA_URL=http://localhost:8082 \
//     pnpm -C gateway e2e
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SignJWT } from 'jose';

const ORG1 = process.env.ORG1_URL ?? 'http://localhost:8080';
const ORG2 = process.env.ORG2_URL ?? 'http://localhost:8081';
const REPLICA = process.env.REPLICA_URL ?? '';
const CONTROL = process.env.CONTROL_URL ?? ''; // an org1 gateway with FRESHNESS=off on the replica
const root = path.resolve(import.meta.dirname, '../..');

interface Step {
  name: string;
  ok: boolean;
  detail: unknown;
  ms: number;
}
const steps: Step[] = [];
let failed = 0;

class Api {
  constructor(
    readonly base: string,
    public token = '',
  ) {}

  async call(method: string, p: string, body?: unknown): Promise<{ status: number; body: any; headers: Headers }> {
    const res = await fetch(this.base + p, {
      method,
      headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }
}

async function login(base: string, username: string): Promise<Api> {
  const api = new Api(base);
  const r = await api.call('POST', '/auth/login', { username, password: `${username}-demo` });
  if (r.status !== 200) throw new Error(`login ${username} at ${base}: ${r.status} ${JSON.stringify(r.body)}`);
  api.token = r.body.token;
  return api;
}

async function step(name: string, fn: () => Promise<{ ok: boolean; detail?: unknown }>) {
  const t0 = performance.now();
  let res: { ok: boolean; detail?: unknown };
  try {
    res = await fn();
  } catch (err) {
    res = { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
  const ms = Math.round(performance.now() - t0);
  steps.push({ name, ok: res.ok, detail: res.detail ?? null, ms });
  if (!res.ok) failed++;
  console.log(`${res.ok ? 'PASS' : 'FAIL'}  ${name}  (${ms} ms)${res.ok ? '' : `  ${JSON.stringify(res.detail)}`}`);
}

const expect = (status: number, want: number | number[], detail?: unknown) => ({
  ok: Array.isArray(want) ? want.includes(status) : status === want,
  detail: { status, ...(typeof detail === 'object' && detail ? detail : { body: detail }) },
});

const inDays = (d: number) => new Date(Date.now() + d * 86400_000).toISOString();

function docker(...args: string[]) {
  execFileSync('docker', args, { stdio: 'ignore' });
}

async function grantConsent(patient: Api, grantee: string, types: string[], actions = ['read']) {
  const r = await patient.call('POST', '/consents', { grantee, types, actions, purpose: 'e2e check', expiresAt: inDays(7) });
  if (r.status !== 200) throw new Error(`grant consent ${grantee}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.result.consentId as string;
}

async function main() {
  const alice = await login(ORG1, 'alice');
  const ben = await login(ORG1, 'ben');
  const chen = await login(ORG1, 'drchen');
  const ada = await login(ORG1, 'ada');
  const rivera = await login(ORG2, 'drrivera');
  const omar = await login(ORG2, 'omar');

  const recs = await alice.call('GET', '/patients/P-1001/records');
  const lab = (recs.body as any[]).find((r) => r.type === 'lab');
  if (!lab) throw new Error(`seeded records missing: ${JSON.stringify(recs.body)}`);

  await step('login: Org2 token rejected by Org1 gateway (401)', async () => {
    const r = await new Api(ORG1, rivera.token).call('GET', '/me');
    return expect(r.status, 401, r.body);
  });
  await step('login: tampered token rejected (401)', async () => {
    const [h, p, s] = alice.token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, 'base64url').toString()), sub: 'ben' })).toString('base64url');
    const r = await new Api(ORG1, `${h}.${forged}.${s}`).call('GET', '/me');
    return expect(r.status, 401, r.body);
  });
  await step('login: expired token rejected (401)', async () => {
    const secret = process.env.ORG1_JWT_SECRET;
    if (!secret) return { ok: false, detail: 'ORG1_JWT_SECRET not set' };
    const t = await new SignJWT({ role: 'patient', ehrId: 'P-1001', org: 'Org1MSP' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('alice')
      .setIssuer('planetary-health/org1')
      .setAudience('org1-api')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(secret));
    const r = await new Api(ORG1, t).call('GET', '/me');
    return expect(r.status, 401, r.body);
  });

  await step('identity: /me shows the certificate-derived identity', async () => {
    const r = await alice.call('GET', '/me');
    return { ok: r.status === 200 && r.body.onChain.id === 'P-1001' && r.body.onChain.role === 'patient', detail: r.body.onChain };
  });

  let accessId = '';
  await step('PHI: doctor with consent gets a grant and a delivery', async () => {
    const g = await chen.call('POST', `/records/${lab.recordId}/access`, { purpose: 'follow-up review' });
    if (g.status !== 200) return expect(g.status, 200, g.body);
    accessId = g.body.grant.accessId;
    const d = await chen.call('POST', `/access/${accessId}/deliver`);
    return { ok: d.status === 200 && typeof d.body.record?.phi === 'string', detail: { status: d.status, freshness: d.body.freshness, receipt: d.body.receipt } };
  });
  await step('PHI: replaying the same accessId returns 409', async () => {
    const r = await chen.call('POST', `/access/${accessId}/deliver`);
    return expect(r.status, 409, r.body);
  });
  await step('PHI: grant used by a different user is denied', async () => {
    const g = await chen.call('POST', `/records/${lab.recordId}/access`, { purpose: 'follow-up review' });
    const r = await alice.call('POST', `/access/${g.body.grant.accessId}/deliver`);
    return expect(r.status, 403, r.body);
  });

  await step('subject substitution: Alice asking for Ben\'s records is denied (403)', async () => {
    const r = await alice.call('GET', '/patients/P-1002/records');
    return expect(r.status, 403, r.body);
  });
  await step('role escalation: patient cannot create a record (403)', async () => {
    const r = await alice.call('POST', '/patients/P-1001/records', { type: 'note', phi: 'self-written' });
    return expect(r.status, 403, r.body);
  });
  await step('role escalation: patient cannot use break-glass (403)', async () => {
    const r = await alice.call('POST', '/emergency', { patientId: 'P-1002', reason: 'pretending to be a doctor' });
    return expect(r.status, 403, r.body);
  });
  await step('minimum necessary: admin cannot read PHI (403)', async () => {
    const r = await ada.call('POST', `/records/${lab.recordId}/access`, { purpose: 'audit' });
    return expect(r.status, 403, r.body);
  });

  await step('cross-org: Org2 doctor without consent is denied (403)', async () => {
    const r = await rivera.call('POST', `/records/${lab.recordId}/access`, { purpose: 'second opinion' });
    return expect(r.status, 403, r.body);
  });
  let riveraConsent = '';
  await step('cross-org: with consent, Org2 doctor reads through the Org2 gateway', async () => {
    riveraConsent = await grantConsent(alice, 'D-3001', ['lab']);
    const r = await rivera.call('POST', `/records/${lab.recordId}/read`, { purpose: 'second opinion' });
    return { ok: r.status === 200, detail: { status: r.status, basis: r.body.record?.basis, freshness: r.body.freshness } };
  });

  await step('revoke after grant: delivery denied once consent is revoked', async () => {
    const g = await rivera.call('POST', `/records/${lab.recordId}/access`, { purpose: 'second opinion' });
    if (g.status !== 200) return expect(g.status, 200, g.body);
    const rv = await alice.call('DELETE', `/consents/${riveraConsent}`);
    if (rv.status !== 200) return expect(rv.status, 200, rv.body);
    const d = await rivera.call('POST', `/access/${g.body.grant.accessId}/deliver`);
    return expect(d.status, 403, { revokedInBlock: rv.body.receipt.blockNumber, body: d.body });
  });

  let bgId = '';
  let benNote = '';
  await step('break-glass: doctor without consent gets 60-minute emergency access', async () => {
    const bg = await chen.call('POST', '/emergency', { patientId: 'P-1002', reason: 'patient unresponsive in ER, allergy check' });
    if (bg.status !== 200) return expect(bg.status, 200, bg.body);
    bgId = bg.body.result.grantId;
    const c = await chen.call('POST', '/patients/P-1002/records', { type: 'allergy', phi: { allergen: 'penicillin', reaction: 'hives' } });
    benNote = c.body.record?.recordId;
    const r = await chen.call('POST', `/records/${benNote}/read`, { purpose: 'emergency treatment' });
    return { ok: c.status === 200 && r.status === 200 && String(r.body.record?.basis).startsWith('breakglass:'), detail: { basis: r.body.record?.basis, expiresAt: bg.body.result.expiresAt } };
  });
  await step('break-glass: grant lands in the patient org\'s review queue, not the other org\'s', async () => {
    const q1 = await ada.call('GET', '/emergency/reviews');
    const q2 = await omar.call('GET', '/emergency/reviews');
    return { ok: (q1.body as any[]).some((g) => g.grantId === bgId) && !(q2.body as any[]).some((g) => g.grantId === bgId), detail: { org1Queue: (q1.body as any[]).length } };
  });
  await step('break-glass: "unjustified" review ends access immediately', async () => {
    const rv = await ada.call('POST', `/emergency/${bgId}/review`, { outcome: 'unjustified', note: 'no ER admission found' });
    const r = await chen.call('POST', `/records/${benNote}/access`, { purpose: 'emergency treatment' });
    return { ok: rv.status === 200 && r.status === 403, detail: { review: rv.status, read: r.status } };
  });

  await step('audit: patient access log lists grants with actor and basis', async () => {
    const r = await alice.call('GET', '/audit/P-1001');
    const grants = r.body.grants as any[];
    return { ok: r.status === 200 && grants.some((g) => g.actor === 'D-2001') && grants.some((g) => g.actorOrg === 'Org2MSP'), detail: { grants: grants.length } };
  });
  await step('audit: reconcile finds no delivery without an on-ledger receipt', async () => {
    await new Promise((r) => setTimeout(r, 1500));
    const r = await alice.call('GET', '/audit/P-1001/reconcile');
    return { ok: r.status === 200 && r.body.missingReceipts.length === 0, detail: { delivered: r.body.delivered, localDeliveries: r.body.localDeliveries, missing: r.body.missingReceipts } };
  });
  await step('integrity: SHA-256 matches ledger and private data hash', async () => {
    const r = await alice.call('POST', `/records/${lab.recordId}/verify`, { sha256: lab.phiSha256 });
    const bad = await alice.call('POST', `/records/${lab.recordId}/verify`, { sha256: '0'.repeat(64) });
    return { ok: r.body.match === true && bad.body.match === false, detail: { good: r.body, bad: bad.body.reason } };
  });

  // Revocation: registry layer (next block), then the CRL layer (MSP validation).
  const temp = `drtemp${Date.now() % 100000}`;
  let tempApi: Api | null = null;
  await step('admin: register and enroll a new doctor through the CA', async () => {
    const r = await ada.call('POST', '/admin/users', { username: temp, displayName: 'Dr. Temp', role: 'doctor', ehrId: `D-${temp}`, password: `${temp}-demo`, specialty: 'Locum' });
    if (r.status !== 200) return expect(r.status, 200, r.body);
    tempApi = await login(ORG1, temp);
    await grantConsent(alice, `D-${temp}`, ['lab']);
    const read = await tempApi.call('POST', `/records/${lab.recordId}/read`, { purpose: 'locum cover' });
    return expect(read.status, 200, { registeredIn: r.body.receipt.blockNumber });
  });
  await step('revocation layer 1: deactivated provider denied at the next block', async () => {
    if (!tempApi) return { ok: false, detail: 'no temp user' };
    const d = await ada.call('POST', `/admin/providers/D-${temp}/active`, { active: false });
    const r = await tempApi.call('POST', `/records/${lab.recordId}/access`, { purpose: 'locum cover' });
    const back = await ada.call('POST', `/admin/providers/D-${temp}/active`, { active: true });
    const again = await tempApi.call('POST', `/records/${lab.recordId}/access`, { purpose: 'locum cover' });
    return { ok: d.status === 200 && r.status === 403 && back.status === 200 && again.status === 200, detail: { denied: r.body, reactivated: again.status } };
  });
  await step('revocation layer 2: CRL in Org1MSP makes the peers reject the certificate', async () => {
    if (!tempApi) return { ok: false, detail: 'no temp user' };
    execFileSync(path.join(root, 'network/revoke-user.sh'), [temp, 'ehrchannel'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 3000));
    const r = await tempApi.call('POST', `/records/${lab.recordId}/access`, { purpose: 'locum cover' });
    const stillOk = await chen.call('GET', '/patients/P-1001/records');
    return { ok: r.status === 403 && stillOk.status === 200, detail: { status: r.status, error: r.body.error, message: r.body.message } };
  });

  if (REPLICA) await replicaChecks(alice, lab.recordId);

  const out = {
    ran_at: new Date().toISOString(),
    passed: steps.length - failed,
    failed,
    steps,
  };
  const file = path.join(root, 'experiments/results/e2e.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`\n${out.passed}/${steps.length} passed; wrote ${path.relative(root, file)}`);
  process.exit(failed ? 1 : 0);
}

// Lagging read replica: the org1 replica gateway serves PHI reads from peer1.org1. Pause the
// peer, commit a revocation, unpause, and read immediately.
async function replicaChecks(alice: Api, recordId: string) {
  const viaReplica = await login(REPLICA, 'drchen');
  const peer = 'peer1.org1.example.com';

  const lagRun = async (label: string, api: Api, keepPaused: boolean) => {
    const consent = await grantConsent(alice, 'D-2001', ['lab']);
    const g = await api.call('POST', `/records/${recordId}/access`, { purpose: label });
    if (g.status !== 200) throw new Error(`grant: ${g.status} ${JSON.stringify(g.body)}`);
    docker('pause', peer);
    let d: Awaited<ReturnType<Api['call']>>;
    let revokeBlock = '';
    try {
      // Revoke every lab consent Alice gave Chen, so only the seeded non-lab scope remains.
      const mine = await alice.call('GET', '/consents');
      for (const c of mine.body as any[]) {
        if (c.grantee === 'D-2001' && c.status === 'active') {
          const rv = await alice.call('DELETE', `/consents/${c.consentId}`);
          revokeBlock = rv.body.receipt?.blockNumber ?? revokeBlock;
        }
      }
      if (!keepPaused) docker('unpause', peer);
      d = await api.call('POST', `/access/${g.body.grant.accessId}/deliver`);
    } finally {
      if (keepPaused) docker('unpause', peer);
    }
    // Restore the seeded consent for later steps.
    await grantConsent(alice, 'D-2001', ['lab', 'note', 'rx'], ['read', 'append']);
    return { consent, revokeBlock, status: d.status, body: d.body };
  };

  await step('freshness: lagging replica waits for the orderer boundary, then denies the revoked read', async () => {
    const r = await lagRun('replica lag', viaReplica, false);
    return { ok: r.status === 403, detail: r };
  });
  await step('freshness: replica kept paused past the timeout returns 503, never stale PHI', async () => {
    const r = await lagRun('replica paused', viaReplica, true);
    return { ok: r.status === 503 && r.body.error === 'STALE_PEER', detail: { status: r.status, error: r.body.error, message: r.body.message } };
  });
  if (CONTROL) {
    // Control: the same sequence with the boundary wait turned off. Recorded, not asserted:
    // whether the lagging peer serves stale data depends on how far it is behind.
    const control = await login(CONTROL, 'drchen');
    const t0 = performance.now();
    const r = await lagRun('control, freshness off', control, false);
    steps.push({ name: 'control (FRESHNESS=off): result of the same lagging read', ok: true, detail: { status: r.status, servedPHI: r.status === 200, error: r.body.error }, ms: Math.round(performance.now() - t0) });
    console.log(`INFO  control with freshness off returned ${r.status}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
