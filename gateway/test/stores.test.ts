import 'reflect-metadata';
import { createPrivateKey, createPublicKey, generateKeyPairSync, verify, webcrypto } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as x509 from '@peculiar/x509';
import { describe, expect, it } from 'vitest';
import { DeliveryStore, ReplayError } from '../src/deliveries.js';
import { caToken, lowS, newKeyAndCsr } from '../src/fabric/ca.js';
import { Wallet } from '../src/wallet.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ph-'));

describe('Wallet', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  it('encrypts keys at rest with 0600 files and round-trips', () => {
    const dir = tmp();
    const w = new Wallet(dir, 'master-key-for-tests');
    w.put({ label: 'alice', mspId: 'Org1MSP', certificate: 'CERT', privateKey: pem });
    const file = path.join(dir, 'alice.id');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('PRIVATE KEY');
    const again = new Wallet(dir, 'master-key-for-tests');
    expect(again.get('alice')?.privateKey).toBe(pem);
    expect(again.list()).toEqual(['alice']);
  });

  it('fails with the wrong master key or a file swapped between labels', () => {
    const dir = tmp();
    const w = new Wallet(dir, 'master-key-for-tests');
    w.put({ label: 'alice', mspId: 'Org1MSP', certificate: 'A', privateKey: pem });
    w.put({ label: 'ben', mspId: 'Org1MSP', certificate: 'B', privateKey: pem });
    expect(() => new Wallet(dir, 'a-different-master-key').get('alice')).toThrow();

    const stolen = JSON.parse(fs.readFileSync(path.join(dir, 'ben.id'), 'utf8'));
    stolen.label = 'alice';
    fs.writeFileSync(path.join(dir, 'alice.id'), JSON.stringify(stolen));
    expect(() => new Wallet(dir, 'master-key-for-tests').get('alice')).toThrow();
  });

  it('binds the key to its MSP ID and certificate', () => {
    const dir = tmp();
    new Wallet(dir, 'master-key-for-tests').put({ label: 'alice', mspId: 'Org1MSP', certificate: 'A', privateKey: pem });
    const file = path.join(dir, 'alice.id');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...stored, certificate: 'MALLORY' }));
    expect(() => new Wallet(dir, 'master-key-for-tests').get('alice')).toThrow();
    fs.writeFileSync(file, JSON.stringify({ ...stored, mspId: 'Org2MSP' }));
    expect(() => new Wallet(dir, 'master-key-for-tests').get('alice')).toThrow();
  });

  it('refuses labels that could escape the directory', () => {
    const w = new Wallet(tmp(), 'master-key-for-tests');
    expect(() => w.put({ label: '../x', mspId: 'm', certificate: 'c', privateKey: pem })).toThrow();
    expect(w.has('../x')).toBe(false);
  });
});

describe('DeliveryStore', () => {
  const row = { accessId: 'A-1', sub: 'drchen', recordId: 'R-1', patientId: 'P-1001', phiSha256: 'ab' };

  it('allows each accessId once', () => {
    const s = new DeliveryStore(':memory:');
    s.consume(row);
    expect(() => s.consume(row)).toThrow(ReplayError);
  });

  it('is append-only for delivery facts', () => {
    const file = path.join(tmp(), 'd.sqlite');
    const s = new DeliveryStore(file);
    s.consume(row);
    s.markRecorded('A-1', 'tx', '9');
    expect(s.get('A-1')?.receipt_state).toBe('recorded');
    const raw = (s as unknown as { db: { exec(sql: string): void } }).db;
    expect(() => raw.exec(`DELETE FROM deliveries`)).toThrow(/append-only/);
    expect(() => raw.exec(`UPDATE deliveries SET sub = 'mallory'`)).toThrow(/immutable/);
    s.close();
    // The uniqueness survives a restart.
    expect(() => new DeliveryStore(file).consume(row)).toThrow(ReplayError);
  });
});

describe('Fabric CA helpers', () => {
  it('normalises ECDSA signatures to low-S', () => {
    const n = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
    const r = 5n;
    const high = n - 7n;
    const enc = (x: bigint) => {
      let h = x.toString(16);
      if (h.length % 2) h = `0${h}`;
      let b = Buffer.from(h, 'hex');
      if ((b[0] ?? 0) & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
      return Buffer.concat([Buffer.from([2, b.length]), b]);
    };
    const body = Buffer.concat([enc(r), enc(high)]);
    const der = Buffer.concat([Buffer.from([0x30, body.length]), body]);
    const out = lowS(der);
    expect(out.toString('hex')).toBe(Buffer.concat([Buffer.from([0x30, 6]), enc(5n), enc(7n)]).toString('hex'));
  });

  it('builds a registrar token the CA can verify', async () => {
    x509.cryptoProvider.set(webcrypto as unknown as Crypto);
    const { privateKey } = await newKeyAndCsr('admin');
    const key = createPrivateKey(privateKey);
    const pub = createPublicKey(key);
    const cryptoKeys = {
      privateKey: await webcrypto.subtle.importKey('pkcs8', key.export({ type: 'pkcs8', format: 'der' }), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']),
      publicKey: await webcrypto.subtle.importKey('spki', pub.export({ type: 'spki', format: 'der' }), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']),
    };
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: '01',
      name: 'CN=admin',
      notBefore: new Date(),
      notAfter: new Date(Date.now() + 86400000),
      keys: cryptoKeys,
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    });
    const certPem = cert.toString('pem');
    const body = Buffer.from('{"id":"x"}');
    const token = caToken({ certificate: certPem, privateKey }, 'POST', '/api/v1/register', body);
    const [b64cert, b64sig] = token.split('.');
    expect(Buffer.from(b64cert!, 'base64').toString()).toBe(certPem);
    const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');
    const payload = `POST.${b64('/api/v1/register')}.${b64(body)}.${b64cert}`;
    expect(verify('sha256', Buffer.from(payload), { key: pub, dsaEncoding: 'der' }, Buffer.from(b64sig!, 'base64'))).toBe(true);
  });

  it('creates a CSR with the enrollment ID as CN', async () => {
    const { csr } = await newKeyAndCsr('drchen');
    const parsed = new x509.Pkcs10CertificateRequest(csr);
    expect(parsed.subject).toBe('CN=drchen');
    expect(await parsed.verify()).toBe(true);
  });
});
