// Enrolls the demo users of both hospitals and writes the on-chain registry and a little data.
// Idempotent: existing wallet identities and registry entries are left alone.
//
//   pnpm -C gateway seed [--no-data]
import fs from 'node:fs';
import path from 'node:path';
import { type Config, loadConfig, type OrgKey } from './config.js';
import { CaError, FabricCA } from './fabric/ca.js';
import { FabricLedger } from './fabric/client.js';
import { toHttpError } from './fabric/errors.js';
import { hashPassword, type Role, UserStore } from './users.js';
import { Wallet } from './wallet.js';

interface SeedUser {
  username: string;
  displayName: string;
  role: Role;
  ehrId: string;
  password: string;
  specialty?: string;
}

const root = path.resolve(import.meta.dirname, '../..');
const all = JSON.parse(fs.readFileSync(path.join(root, 'network/users.json'), 'utf8')) as Record<OrgKey, SeedUser[]>;

function orgConfig(org: OrgKey): Config {
  return loadConfig({ ...process.env, ORG: org });
}

async function enroll(cfg: Config, wallet: Wallet, ca: FabricCA, label: string, attrs: { name: string; value: string }[]) {
  if (wallet.has(label)) return false;
  const registrar = wallet.get('ca-registrar')!;
  let secret: string;
  try {
    secret = await ca.register(registrar, { id: label, type: 'client', attrs: attrs.map((a) => ({ ...a, ecert: true })) });
  } catch (err) {
    if (err instanceof CaError && /already registered/i.test(err.message)) {
      throw new Error(`${label} is registered at the CA but missing from the wallet; run network/down.sh and start over`);
    }
    throw err;
  }
  const creds = await ca.enroll(label, secret);
  wallet.put({ label, mspId: cfg.mspId, ...creds });
  return true;
}

async function chain<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    const e = toHttpError(err);
    if (e.body.error === 'CONFLICT') {
      console.log(`  ${what}: already done`);
      return null;
    }
    throw err;
  }
}

async function seedOrg(org: OrgKey) {
  const cfg = orgConfig(org);
  const wallet = new Wallet(cfg.walletDir, cfg.walletKey);
  const users = new UserStore(cfg.walletDir);
  const ca = new FabricCA(cfg.ca.url, cfg.ca.name, fs.readFileSync(cfg.ca.tlsCert));
  console.log(`${cfg.displayName} (${cfg.mspId})`);

  if (!wallet.has('ca-registrar')) {
    wallet.put({ label: 'ca-registrar', mspId: cfg.mspId, ...(await ca.enroll('admin', 'adminpw')) });
    console.log('  enrolled CA registrar');
  }
  // probe: an org member with no ehr attributes, used only for readiness checks (Ping,
  // Deliver). The chaincode denies it everything else.
  if (await enroll(cfg, wallet, ca, 'probe', [])) console.log('  enrolled probe');
  for (const u of all[org]) {
    const fresh = await enroll(cfg, wallet, ca, u.username, [
      { name: 'ehr.role', value: u.role },
      { name: 'ehr.id', value: u.ehrId },
    ]);
    if (!users.get(u.username)) {
      users.upsert({ sub: u.username, ehrId: u.ehrId, role: u.role, displayName: u.displayName, specialty: u.specialty, passwordHash: await hashPassword(u.password) });
    }
    if (fresh) console.log(`  enrolled ${u.username} (${u.role} ${u.ehrId})`);
  }

  const ledger = new FabricLedger(cfg, wallet);
  try {
    const admin = all[org].find((u) => u.role === 'admin')!;
    await chain('bootstrap admin', () => ledger.submit(admin.username, 'BootstrapAdmin', []));
    for (const u of all[org]) {
      if (u.username === admin.username) continue;
      const fn = { patient: 'RegisterPatient', doctor: 'RegisterProvider', admin: 'RegisterAdmin' }[u.role];
      const args = u.role === 'doctor' ? [u.ehrId, u.username, u.specialty ?? ''] : [u.ehrId, u.username];
      const r = await chain(`register ${u.ehrId}`, () => ledger.submit(admin.username, fn, args));
      if (r) console.log(`  registered ${u.ehrId} in block ${r.receipt.blockNumber}`);
    }
  } finally {
    ledger.close();
  }
}

async function seedData() {
  const cfg = orgConfig('org1');
  const ledger = new FabricLedger(cfg, new Wallet(cfg.walletDir, cfg.walletKey));
  try {
    const existing = await ledger.evaluate<unknown[]>('alice', 'ListMyConsents', []);
    if (existing.length > 0) {
      console.log('sample data already present');
      return;
    }
    const in90d = new Date(Date.now() + 90 * 86400_000).toISOString();
    await ledger.submit('alice', 'GrantConsent', ['D-2001', JSON.stringify(['lab', 'note', 'rx']), JSON.stringify(['read', 'append']), 'ongoing cardiology care', in90d]);
    const records: [string, object][] = [
      ['lab', { test: 'HbA1c', value: '6.1 %', reference: '4.0-5.6 %', collected: '2024-08-30' }],
      ['lab', { test: 'LDL cholesterol', value: '131 mg/dL', reference: '<100 mg/dL', collected: '2024-08-30' }],
      ['note', { author: 'Dr. Lin Chen', text: 'Follow-up for borderline HbA1c. Diet counselling given; recheck in 3 months.' }],
      ['rx', { drug: 'Atorvastatin', dose: '20 mg', frequency: 'once daily', days: 90 }],
    ];
    for (const [type, phi] of records) {
      const r = await ledger.submit<{ recordId: string }>('drchen', 'CreateRecord', ['P-1001', type], { phi: Buffer.from(JSON.stringify(phi)) });
      console.log(`  record ${r.result.recordId} (${type}) in block ${r.receipt.blockNumber}`);
    }
  } finally {
    ledger.close();
  }
}

async function main() {
  for (const org of ['org1', 'org2'] as const) await seedOrg(org);
  if (!process.argv.includes('--no-data')) await seedData();
  console.log('seed done');
}

main().catch((err) => {
  console.error('seed failed:', err instanceof Error ? err.message : err, toHttpError(err).body);
  process.exit(1);
});
