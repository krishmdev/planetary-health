import { createPrivateKey } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import { connect, type Contract, type Gateway, hash, signers } from '@hyperledger/fabric-gateway';
import { loadConfig, type OrgKey } from '../../../gateway/src/config.js';
import { Wallet } from '../../../gateway/src/wallet.js';
import { ROOT } from './manifest.js';

// Load .env so the harness sees the same wallet keys as the gateways.
export function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2];
  }
}

export interface Conn {
  gateway: Gateway;
  client: grpc.Client;
  contract: Contract;
  close(): void;
}

// A direct fabric-gateway connection as one wallet identity, bypassing the HTTP layer.
export function connectAs(org: OrgKey, user: string, channel: string, commitTimeoutMs = 60_000): Conn {
  loadEnv();
  const cfg = loadConfig({ ...process.env, ORG: org, CHANNEL: channel });
  const id = new Wallet(cfg.walletDir, cfg.walletKey).get(user);
  if (!id) throw new Error(`no wallet identity ${user} for ${org}; run the seed first`);
  const client = new grpc.Client(cfg.peer.endpoint, grpc.credentials.createSsl(fs.readFileSync(cfg.tlsRootCert)), {
    'grpc.ssl_target_name_override': cfg.peer.hostAlias,
  });
  const d = (ms: number) => () => ({ deadline: Date.now() + ms });
  const gateway = connect({
    client,
    identity: { mspId: id.mspId, credentials: Buffer.from(id.certificate) },
    signer: signers.newPrivateKeySigner(createPrivateKey(id.privateKey)),
    hash: hash.sha256,
    evaluateOptions: d(5000),
    endorseOptions: d(15000),
    submitOptions: d(5000),
    commitStatusOptions: d(commitTimeoutMs),
  });
  const contract = gateway.getNetwork(channel).getContract('ehr');
  return {
    gateway,
    client,
    contract,
    close: () => {
      gateway.close();
      client.close();
    },
  };
}

export const ORDERERS = [
  { name: 'orderer.example.com', id: 1, ops: 'http://localhost:9443' },
  { name: 'orderer2.example.com', id: 2, ops: 'http://localhost:9446' },
  { name: 'orderer3.example.com', id: 3, ops: 'http://localhost:9447' },
  { name: 'orderer4.example.com', id: 4, ops: 'http://localhost:9448' },
];

async function metrics(url: string): Promise<string | null> {
  try {
    const r = await fetch(`${url}/metrics`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  }
}

function metric(text: string, name: string, channel: string): number | undefined {
  for (const line of text.split('\n')) {
    if (line.startsWith(name) && line.includes(`channel="${channel}"`)) return Number(line.trim().split(/\s+/).pop());
  }
  return undefined;
}

// Current leader of a channel: consensus_BFT_leader_id for BFT, consensus_etcdraft_is_leader for Raft.
export async function leaderOf(channel: string, bft: boolean, skip: string[] = []): Promise<(typeof ORDERERS)[number] | null> {
  for (const o of ORDERERS) {
    if (skip.includes(o.name)) continue;
    const t = await metrics(o.ops);
    if (!t) continue;
    if (bft) {
      const id = metric(t, 'consensus_BFT_leader_id', channel);
      if (id) return ORDERERS.find((x) => x.id === id) ?? null;
    } else if (metric(t, 'consensus_etcdraft_is_leader', channel) === 1) {
      return o;
    }
  }
  return null;
}
