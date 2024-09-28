import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { createApp } from '../src/app.js';
import { Tokens } from '../src/auth.js';
import { DeliveryStore } from '../src/deliveries.js';
import {
  type ChaincodeEventMessage,
  type EndorseProbe,
  FreshnessTimeout,
  type Ledger,
  type Transient,
  type TxReceipt,
} from '../src/fabric/ledger.js';
import { PhiService } from '../src/phi.js';
import { hashPassword, UserStore } from '../src/users.js';

export type Call = { kind: 'evaluate' | 'submit'; user: string; fn: string; args: string[]; transient?: Transient; readPeer?: boolean };

type Handler = (user: string, args: string[], transient?: Transient) => unknown;

// ScriptedLedger answers chaincode calls from per-function handlers and records every call.
// Peer height and the orderer boundary are plain fields tests can move.
export class ScriptedLedger implements Ledger {
  calls: Call[] = [];
  handlers = new Map<string, Handler>();
  boundary = 10n;
  peerHeight = 11n; // committed through block peerHeight-1
  catchUpAfterMs: number | null = null;
  block = 10n;
  events: ((e: ChaincodeEventMessage) => void)[] = [];
  submitFailure: ((fn: string) => Error | null) | null = null;

  on(fn: string, h: Handler): this {
    this.handlers.set(fn, h);
    return this;
  }

  private run(fn: string, user: string, args: string[], transient?: Transient): unknown {
    const h = this.handlers.get(fn);
    if (!h) throw new Error(`no handler for ${fn}`);
    return h(user, args, transient);
  }

  async evaluate<T>(user: string, fn: string, args: string[], opts?: { readPeer?: boolean }): Promise<T> {
    this.calls.push({ kind: 'evaluate', user, fn, args, readPeer: opts?.readPeer });
    return this.run(fn, user, args) as T;
  }

  async submit<T>(user: string, fn: string, args: string[], transient?: Transient): Promise<{ result: T; receipt: TxReceipt }> {
    this.calls.push({ kind: 'submit', user, fn, args, transient });
    const failure = this.submitFailure?.(fn);
    if (failure) throw failure;
    const result = this.run(fn, user, args, transient) as T;
    this.block += 1n;
    this.boundary = this.block;
    if (this.peerHeight <= this.block) this.peerHeight = this.block + 1n;
    return { result, receipt: { txId: `tx${this.calls.length}`, blockNumber: this.block.toString(), status: 'VALID' } };
  }

  async ordererBoundary(): Promise<bigint> {
    return this.boundary;
  }

  waitedFor: bigint[] = [];

  async waitForPeerBlock(_user: string, block: bigint, timeoutMs: number): Promise<void> {
    this.waitedFor.push(block);
    if (this.peerHeight > block) return;
    if (this.catchUpAfterMs !== null && this.catchUpAfterMs < timeoutMs) {
      await new Promise((r) => setTimeout(r, this.catchUpAfterMs!));
      this.peerHeight = block + 1n;
      return;
    }
    await new Promise((r) => setTimeout(r, Math.min(timeoutMs, 50)));
    throw new FreshnessTimeout(block, timeoutMs);
  }

  async endorseProbe(): Promise<EndorseProbe> {
    return { endorsedBy: ['Org1MSP', 'Org2MSP'], ms: 1 };
  }

  async chaincodeEvents(_user: string, onEvent: (e: ChaincodeEventMessage) => void): Promise<() => void> {
    this.events.push(onEvent);
    return () => {
      this.events = this.events.filter((f) => f !== onEvent);
    };
  }

  close(): void {}
}

export const SECRET = 'test-secret-that-is-at-least-32-characters';

export async function harness(opts: { freshness?: boolean; timeoutMs?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-gw-'));
  const users = new UserStore(dir);
  const pw = await hashPassword('alice-demo');
  users.upsert({ sub: 'alice', ehrId: 'P-1001', role: 'patient', displayName: 'Alice Moreno', passwordHash: pw });
  users.upsert({ sub: 'drchen', ehrId: 'D-2001', role: 'doctor', displayName: 'Dr. Lin Chen', passwordHash: await hashPassword('drchen-demo') });
  users.upsert({ sub: 'ada', ehrId: 'A-1001', role: 'admin', displayName: 'Ada Okafor', passwordHash: await hashPassword('ada-demo') });
  const identities = new Set(['alice', 'drchen', 'ada', 'probe']);
  const wallet = {
    has: (l: string) => identities.has(l),
    get: () => null,
    put: (id: { label: string }) => {
      identities.add(id.label);
    },
    remove: (l: string) => {
      identities.delete(l);
    },
  };
  const ledger = new ScriptedLedger();
  const deliveries = new DeliveryStore(':memory:');
  const log = pino({ level: 'silent' });
  const phi = new PhiService(ledger, deliveries, { freshness: opts.freshness ?? true, freshnessTimeoutMs: opts.timeoutMs ?? 200 }, log);
  const tokens = new Tokens({ secret: SECRET, issuer: 'planetary-health/org1', audience: 'org1-api', ttlSeconds: 900 });
  const app = createApp({
    org: 'org1',
    mspId: 'Org1MSP',
    displayName: 'Mercy General',
    channel: 'ehrchannel',
    f: 1,
    orderers: [],
    peers: [],
    ledger,
    wallet,
    users,
    tokens,
    phi,
    deliveries,
    fetcher: async () => ({ status: 200, text: '' }),
    log,
  });
  const token = async (sub: string, role: 'patient' | 'doctor' | 'admin', ehrId: string) =>
    (await tokens.issue({ sub, role, ehrId, org: 'Org1MSP' })).token;
  return { app, ledger, deliveries, phi, tokens, users, token, dir };
}
