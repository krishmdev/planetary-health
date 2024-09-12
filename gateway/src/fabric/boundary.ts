import { createHash, randomBytes } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import type { Signer } from '@hyperledger/fabric-gateway';
import { common, msp, orderer } from '@hyperledger/fabric-protos';
import { Timestamp } from 'google-protobuf/google/protobuf/timestamp_pb.js';
import { OrderingUnavailable } from './ledger.js';

// The freshness boundary for a PHI read comes from the ordering service itself, not from any
// peer: a Deliver request with SeekNewest returns the newest block an orderer has. We ask all
// orderers and use the max over the first f+1 answers, so one lagging or Byzantine orderer can't
// understate the height. An overstated height can only make the read wait and then fail with 503.

export interface OrdererTarget {
  name: string;
  endpoint: string;
  hostAlias: string;
}

export interface DeliverIdentity {
  mspId: string;
  certificate: Uint8Array;
  signer: Signer;
}

export function seekNewestEnvelope(channel: string, id: DeliverIdentity): Promise<common.Envelope> {
  const newest = new orderer.SeekPosition();
  newest.setNewest(new orderer.SeekNewest());
  const seek = new orderer.SeekInfo();
  seek.setStart(newest);
  seek.setStop(newest);
  seek.setBehavior(orderer.SeekInfo.SeekBehavior.BLOCK_UNTIL_READY);
  seek.setContentType(orderer.SeekInfo.SeekContentType.HEADER_WITH_SIG);

  const ch = new common.ChannelHeader();
  ch.setType(common.HeaderType.DELIVER_SEEK_INFO);
  ch.setChannelId(channel);
  ch.setTimestamp(Timestamp.fromDate(new Date()));
  ch.setEpoch(0);

  const creator = new msp.SerializedIdentity();
  creator.setMspid(id.mspId);
  creator.setIdBytes(id.certificate);
  const sh = new common.SignatureHeader();
  sh.setCreator(creator.serializeBinary());
  sh.setNonce(randomBytes(24));

  const header = new common.Header();
  header.setChannelHeader(ch.serializeBinary());
  header.setSignatureHeader(sh.serializeBinary());
  const payload = new common.Payload();
  payload.setHeader(header);
  payload.setData(seek.serializeBinary());
  const bytes = payload.serializeBinary();

  return id.signer(createHash('sha256').update(bytes).digest()).then((signature) => {
    const env = new common.Envelope();
    env.setPayload(bytes);
    env.setSignature(signature);
    return env;
  });
}

export class OrdererClients {
  private clients = new Map<string, orderer.AtomicBroadcastClient>();

  constructor(
    private targets: OrdererTarget[],
    private tlsRootCert: Buffer,
  ) {}

  private client(t: OrdererTarget): orderer.AtomicBroadcastClient {
    let c = this.clients.get(t.name);
    if (!c) {
      c = new orderer.AtomicBroadcastClient(t.endpoint, grpc.credentials.createSsl(this.tlsRootCert), {
        'grpc.ssl_target_name_override': t.hostAlias,
      });
      this.clients.set(t.name, c);
    }
    return c;
  }

  // newestBlock asks one orderer for its newest block number.
  newestBlock(t: OrdererTarget, env: common.Envelope, timeoutMs: number): Promise<bigint> {
    return new Promise((resolve, reject) => {
      const call = this.client(t).deliver({ deadline: Date.now() + timeoutMs });
      let done = false;
      const finish = (err: Error | null, n?: bigint) => {
        if (done) return;
        done = true;
        call.cancel();
        if (err) reject(err);
        else resolve(n as bigint);
      };
      call.on('data', (resp: orderer.DeliverResponse) => {
        if (resp.getTypeCase() === orderer.DeliverResponse.TypeCase.BLOCK) {
          const num = resp.getBlock()?.getHeader()?.getNumber();
          if (num === undefined) finish(new Error(`${t.name}: block without header`));
          else finish(null, BigInt(num));
        } else if (resp.getTypeCase() === orderer.DeliverResponse.TypeCase.STATUS) {
          finish(new Error(`${t.name}: deliver status ${resp.getStatus()}`));
        }
      });
      call.on('error', (e: Error) => finish(new Error(`${t.name}: ${e.message}`)));
      call.on('end', () => finish(new Error(`${t.name}: stream ended without a block`)));
      call.write(env);
    });
  }

  close(): void {
    for (const c of this.clients.values()) c.close();
    this.clients.clear();
  }

  get size(): number {
    return this.targets.length;
  }

  list(): OrdererTarget[] {
    return this.targets;
  }
}

export interface BoundaryResult {
  newest: bigint;
  answered: string[];
  failed: string[];
}

// quorumNewest resolves with the max newest-block over the first `need` orderers to answer.
export async function quorumNewest(
  targets: OrdererTarget[],
  need: number,
  ask: (t: OrdererTarget) => Promise<bigint>,
): Promise<BoundaryResult> {
  if (need > targets.length) throw new OrderingUnavailable(`need ${need} orderers, only ${targets.length} configured`);
  return new Promise((resolve, reject) => {
    const answers: { name: string; n: bigint }[] = [];
    const failed: string[] = [];
    let settled = false;
    for (const t of targets) {
      ask(t).then(
        (n) => {
          if (settled) return;
          answers.push({ name: t.name, n });
          if (answers.length >= need) {
            settled = true;
            const newest = answers.reduce((m, a) => (a.n > m ? a.n : m), answers[0]!.n);
            resolve({ newest, answered: answers.map((a) => a.name), failed });
          }
        },
        (err: Error) => {
          if (settled) return;
          failed.push(`${t.name}: ${err.message}`);
          if (targets.length - failed.length < need) {
            settled = true;
            reject(new OrderingUnavailable(`only ${answers.length} of the ${need} orderers needed answered: ${failed.join('; ')}`));
          }
        },
      );
    }
  });
}
