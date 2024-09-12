import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { signers } from '@hyperledger/fabric-gateway';
import { common, msp, orderer } from '@hyperledger/fabric-protos';
import { describe, expect, it } from 'vitest';
import { quorumNewest, seekNewestEnvelope } from '../src/fabric/boundary.js';
import { OrderingUnavailable } from '../src/fabric/ledger.js';

const targets = ['o1', 'o2', 'o3', 'o4'].map((name) => ({ name, endpoint: `${name}:7050`, hostAlias: name }));
const delay = <T>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));

describe('quorumNewest', () => {
  it('takes the max of the first f+1 answers', async () => {
    const heights: Record<string, [number, bigint]> = { o1: [5, 10n], o2: [10, 14n], o3: [50, 99n], o4: [60, 1n] };
    const r = await quorumNewest(targets, 2, (t) => delay(heights[t.name]![0], heights[t.name]![1]));
    expect(r.newest).toBe(14n);
    expect(r.answered.sort()).toEqual(['o1', 'o2']);
  });

  it('a single lagging orderer cannot understate the boundary', async () => {
    // o1 answers first with a stale height; the second answer lifts the max.
    const r = await quorumNewest(targets, 2, (t) => (t.name === 'o1' ? delay(1, 3n) : delay(5, 20n)));
    expect(r.newest).toBe(20n);
  });

  it('tolerates f failures and fails when fewer than f+1 answer', async () => {
    const one = await quorumNewest(targets, 2, (t) => (t.name === 'o1' ? Promise.reject(new Error('down')) : delay(1, 7n)));
    expect(one.newest).toBe(7n);
    expect(one.failed).toHaveLength(1);
    await expect(
      quorumNewest(targets, 2, (t) => (t.name === 'o4' ? delay(1, 7n) : Promise.reject(new Error('down')))),
    ).rejects.toBeInstanceOf(OrderingUnavailable);
    await expect(quorumNewest(targets.slice(0, 1), 2, async () => 1n)).rejects.toBeInstanceOf(OrderingUnavailable);
  });
});

describe('seekNewestEnvelope', () => {
  it('builds a signed DELIVER_SEEK_INFO envelope for newest..newest', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const cert = new TextEncoder().encode('-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n');
    const env = await seekNewestEnvelope('ehrchannel', { mspId: 'Org1MSP', certificate: cert, signer: signers.newPrivateKeySigner(privateKey) });

    const payload = common.Payload.deserializeBinary(env.getPayload_asU8());
    const ch = common.ChannelHeader.deserializeBinary(payload.getHeader()!.getChannelHeader_asU8());
    expect(ch.getType()).toBe(common.HeaderType.DELIVER_SEEK_INFO);
    expect(ch.getChannelId()).toBe('ehrchannel');
    const sh = common.SignatureHeader.deserializeBinary(payload.getHeader()!.getSignatureHeader_asU8());
    const creator = msp.SerializedIdentity.deserializeBinary(sh.getCreator_asU8());
    expect(creator.getMspid()).toBe('Org1MSP');
    const seek = orderer.SeekInfo.deserializeBinary(payload.getData_asU8());
    expect(seek.getStart()!.hasNewest()).toBe(true);
    expect(seek.getStop()!.hasNewest()).toBe(true);
    expect(seek.getBehavior()).toBe(orderer.SeekInfo.SeekBehavior.BLOCK_UNTIL_READY);

    // The signer signs sha256(payload), which is exactly ECDSA-SHA256 over the payload.
    const ok = verify('sha256', env.getPayload_asU8(), { key: createPublicKey(privateKey), dsaEncoding: 'der' }, env.getSignature_asU8());
    expect(ok).toBe(true);
  });
});
