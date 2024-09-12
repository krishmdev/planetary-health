import { createPrivateKey } from 'node:crypto';
import fs from 'node:fs';
import * as grpc from '@grpc/grpc-js';
import { connect, type Gateway, hash, signers, type Signer } from '@hyperledger/fabric-gateway';
import type { Config } from '../config.js';
import type { Wallet } from '../wallet.js';
import { OrdererClients, quorumNewest, seekNewestEnvelope } from './boundary.js';
import {
  type ChaincodeEventMessage,
  CommitFailed,
  type EndorseProbe,
  FreshnessTimeout,
  type Ledger,
  type Transient,
  type TxReceipt,
} from './ledger.js';
import { StatusNames } from './status.js';

const utf8 = new TextDecoder();

function parse<T>(bytes: Uint8Array): T {
  const s = utf8.decode(bytes);
  return (s ? JSON.parse(s) : null) as T;
}

interface Session {
  gateway: Gateway;
  signer: Signer;
  certificate: Uint8Array;
  mspId: string;
}

// FabricLedger holds one gRPC connection per peer and one Gateway per wallet identity on top of
// it. Nothing is ever signed with a shared identity: `user` picks the wallet entry.
export class FabricLedger implements Ledger {
  private submitPeer: grpc.Client;
  private readPeer: grpc.Client;
  private sessions = new Map<string, Session>();
  private orderers: OrdererClients;

  constructor(
    private cfg: Config,
    private wallet: Wallet,
  ) {
    const tls = fs.readFileSync(cfg.tlsRootCert);
    const mk = (endpoint: string, alias: string) =>
      new grpc.Client(endpoint, grpc.credentials.createSsl(tls), { 'grpc.ssl_target_name_override': alias });
    this.submitPeer = mk(cfg.peer.endpoint, cfg.peer.hostAlias);
    this.readPeer = cfg.readPeer ? mk(cfg.readPeer.endpoint, cfg.readPeer.hostAlias) : this.submitPeer;
    this.orderers = new OrdererClients(cfg.orderers, fs.readFileSync(cfg.ordererTlsRootCert));
  }

  private session(user: string, read: boolean): Session {
    const key = `${read && this.cfg.readPeer ? 'read' : 'submit'}:${user}`;
    const hit = this.sessions.get(key);
    if (hit) return hit;
    const id = this.wallet.get(user);
    if (!id) throw new Error(`no wallet identity for ${user}`);
    const certificate = Buffer.from(id.certificate);
    const signer = signers.newPrivateKeySigner(createPrivateKey(id.privateKey));
    const deadline = (ms: number) => () => ({ deadline: Date.now() + ms });
    const gateway = connect({
      client: read ? this.readPeer : this.submitPeer,
      identity: { mspId: id.mspId, credentials: certificate },
      signer,
      hash: hash.sha256,
      evaluateOptions: deadline(5000),
      endorseOptions: deadline(15000),
      submitOptions: deadline(5000),
      commitStatusOptions: deadline(this.cfg.commitTimeoutMs),
    });
    const s = { gateway, signer, certificate, mspId: id.mspId };
    this.sessions.set(key, s);
    return s;
  }

  private contract(user: string, read = false) {
    return this.session(user, read).gateway.getNetwork(this.cfg.channel).getContract(this.cfg.chaincode);
  }

  async evaluate<T>(user: string, fn: string, args: string[], opts?: { readPeer?: boolean }): Promise<T> {
    const bytes = await this.contract(user, opts?.readPeer ?? false).evaluate(fn, { arguments: args });
    return parse<T>(bytes);
  }

  async submit<T>(user: string, fn: string, args: string[], transient?: Transient): Promise<{ result: T; receipt: TxReceipt }> {
    const contract = this.contract(user);
    const sub = await contract.submitAsync(fn, { arguments: args, transientData: transient });
    const status = await sub.getStatus();
    const name = StatusNames[status.code] ?? String(status.code);
    if (!status.successful) throw new CommitFailed(status.transactionId, name, status.blockNumber.toString());
    return {
      result: parse<T>(sub.getResult()),
      receipt: { txId: status.transactionId, blockNumber: status.blockNumber.toString(), status: name },
    };
  }

  async ordererBoundary(user: string): Promise<bigint> {
    const s = this.session(user, false);
    const env = await seekNewestEnvelope(this.cfg.channel, { mspId: s.mspId, certificate: s.certificate, signer: s.signer });
    const r = await quorumNewest(this.orderers.list(), this.cfg.f + 1, (t) => this.orderers.newestBlock(t, env, 3000));
    return r.newest;
  }

  async waitForPeerBlock(user: string, block: bigint, timeoutMs: number, opts?: { readPeer?: boolean }): Promise<void> {
    const network = this.session(user, opts?.readPeer ?? true).gateway.getNetwork(this.cfg.channel);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let events: Awaited<ReturnType<typeof network.getFilteredBlockEvents>> | undefined;
    try {
      const wait = (async () => {
        events = await network.getFilteredBlockEvents({ startBlock: block });
        for await (const b of events) {
          if (BigInt(b.getNumber()) >= block) return;
        }
        throw new Error('block event stream ended');
      })();
      const timeout = new Promise<never>((_, reject) =>
        ac.signal.addEventListener('abort', () => reject(new FreshnessTimeout(block, timeoutMs))),
      );
      await Promise.race([wait, timeout]);
    } finally {
      clearTimeout(timer);
      events?.close();
    }
  }

  // endorseProbe collects real endorsements for Ping from both orgs and throws the transaction
  // away. It proves both peers are up with the chaincode running; nothing reaches the ledger.
  async endorseProbe(user: string): Promise<EndorseProbe> {
    const t0 = performance.now();
    const proposal = this.contract(user).newProposal('Ping', { endorsingOrganizations: ['Org1MSP', 'Org2MSP'] });
    await proposal.endorse();
    return { endorsedBy: ['Org1MSP', 'Org2MSP'], ms: Math.round(performance.now() - t0) };
  }

  async chaincodeEvents(user: string, onEvent: (e: ChaincodeEventMessage) => void): Promise<() => void> {
    const network = this.session(user, false).gateway.getNetwork(this.cfg.channel);
    const events = await network.getChaincodeEvents(this.cfg.chaincode);
    (async () => {
      try {
        for await (const e of events) {
          let payload: unknown = null;
          try {
            payload = parse(e.payload);
          } catch {
            payload = null;
          }
          onEvent({ eventName: e.eventName, txId: e.transactionId, blockNumber: e.blockNumber.toString(), payload });
        }
      } catch {
        // closed by the caller or the peer went away; the SSE client reconnects
      }
    })();
    return () => events.close();
  }

  close(): void {
    for (const s of this.sessions.values()) s.gateway.close();
    this.sessions.clear();
    this.orderers.close();
    this.submitPeer.close();
    if (this.readPeer !== this.submitPeer) this.readPeer.close();
  }
}
