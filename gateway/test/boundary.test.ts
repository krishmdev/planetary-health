import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { signers } from '@hyperledger/fabric-gateway';
import { common, msp, orderer } from '@hyperledger/fabric-protos';
import { describe, expect, it } from 'vitest';
import { quorumNewest, seekNewestEnvelope } from '../src/fabric/boundary.js';
import { OrderingUnavailable } from '../src/fabric/ledger.js';

const targets = ['o1', 'o2', 'o3', 'o4'].map((name) => ({ name, endpoint: `${name}:7050`, hostAlias: name }));
const delay = <T>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));

describe('quorumNewest (n=4, f=1: wait for 3 answers, take the 2nd largest)', () => {
  const names = (r: { answers: { name: string }[] }) => r.answers.map((a) => a.name).sort();

  it('uses the first n-f answers', async () => {
    const heights: Record<string, [number, bigint]> = { o1: [5, 10n], o2: [10, 14n], o3: [20, 12n], o4: [60, 99n] };
    const r = await quorumNewest(targets, 1, (t) => delay(heights[t.name]![0], heights[t.name]![1]));
    expect(names(r)).toEqual(['o1', 'o2', 'o3']);
    expect(r.newest).toBe(12n);
  });

  it('one Byzantine orderer cannot inflate the boundary', async () => {
    const r = await quorumNewest(targets, 1, (t) => delay(1, t.name === 'o2' ? 1_000_000n : 20n));
    expect(r.newest).toBe(20n);
  });

  it('one Byzantine or lagging orderer cannot understate it below two honest answers', async () => {
    const r = await quorumNewest(targets, 1, (t) => (t.name === 'o1' ? delay(1, 3n) : delay(5, 20n)));
    expect(r.newest).toBe(20n);
  });

  it('tolerates f failures and fails when fewer than n-f answer', async () => {
    const one = await quorumNewest(targets, 1, (t) => (t.name === 'o1' ? Promise.reject(new Error('down')) : delay(1, 7n)));
    expect(one.newest).toBe(7n);
    expect(one.failed).toHaveLength(1);
    await expect(
      quorumNewest(targets, 1, (t) => (t.name === 'o3' || t.name === 'o4' ? Promise.reject(new Error('down')) : delay(1, 7n))),
    ).rejects.toBeInstanceOf(OrderingUnavailable);
    await expect(quorumNewest(targets.slice(0, 2), 1, async () => 1n)).rejects.toBeInstanceOf(OrderingUnavailable);
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
