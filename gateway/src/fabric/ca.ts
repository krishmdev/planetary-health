import 'reflect-metadata';
import { createHash, createPrivateKey, randomBytes, sign as nodeSign, webcrypto } from 'node:crypto';
import https from 'node:https';
import * as x509 from '@peculiar/x509';

// A minimal Fabric CA REST client: enroll (basic auth + CSR), register and revoke (token auth
// signed by the registrar). Enough for the org admin routes and the seed script, without the
// deprecated fabric-ca-client SDK.

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

export interface Credentials {
  certificate: string;
  privateKey: string;
}

export interface Attribute {
  name: string;
  value: string;
  ecert?: boolean;
}

export interface RegisterRequest {
  id: string;
  secret?: string;
  type?: 'client' | 'peer' | 'admin';
  attrs?: Attribute[];
  maxEnrollments?: number;
}

const P256_N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');

function derLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  for (let l = len; l > 0; l >>= 8) bytes.unshift(l & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derInt(n: bigint): Buffer {
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let b = Buffer.from(hex, 'hex');
  if ((b[0] ?? 0) & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return Buffer.concat([Buffer.from([0x02]), derLength(b.length), b]);
}

// Fabric rejects ECDSA signatures with a high S value, so normalise to s <= n/2.
export function lowS(der: Buffer): Buffer {
  let i = 2;
  if ((der[1] ?? 0) & 0x80) i = 2 + ((der[1] ?? 0) & 0x7f);
  const readInt = (): bigint => {
    if (der[i] !== 0x02) throw new Error('bad DER signature');
    const len = der[i + 1] ?? 0;
    const v = BigInt(`0x${der.subarray(i + 2, i + 2 + len).toString('hex') || '0'}`);
    i += 2 + len;
    return v;
  };
  const r = readInt();
  let s = readInt();
  if (s > P256_N / 2n) s = P256_N - s;
  const body = Buffer.concat([derInt(r), derInt(s)]);
  return Buffer.concat([Buffer.from([0x30]), derLength(body.length), body]);
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64');

export function caToken(registrar: Credentials, method: string, uri: string, body: Buffer): string {
  const b64cert = b64(registrar.certificate);
  const payload = `${method}.${b64(uri)}.${b64(body)}.${b64cert}`;
  const der = nodeSign('sha256', Buffer.from(payload), { key: createPrivateKey(registrar.privateKey), dsaEncoding: 'der' });
  return `${b64cert}.${b64(lowS(der))}`;
}

export async function newKeyAndCsr(commonName: string): Promise<{ csr: string; privateKey: string }> {
  const keys = (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${commonName}`,
    keys,
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
  });
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  const pem = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }).export({ format: 'pem', type: 'pkcs8' }).toString();
  return { csr: csr.toString('pem'), privateKey: pem };
}

interface CaResponse<T> {
  success: boolean;
  result: T;
  errors: { code: number; message: string }[];
}

export class CaError extends Error {
  constructor(
    message: string,
    readonly codes: number[],
  ) {
    super(message);
    this.name = 'CaError';
  }
}

export class FabricCA {
  constructor(
    private url: string,
    private caName: string,
    private tlsCert: Buffer,
  ) {}

  private request<T>(uriPath: string, body: object, auth: string): Promise<T> {
    const data = Buffer.from(JSON.stringify(body));
    const u = new URL(uriPath, this.url);
    return new Promise((resolve, reject) => {
      const req = https.request(
        u,
        {
          method: 'POST',
          ca: this.tlsCert,
          headers: { 'content-type': 'application/json', 'content-length': data.length, authorization: auth },
          timeout: 10_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as CaResponse<T>;
              if (!parsed.success) {
                reject(new CaError(parsed.errors.map((e) => e.message).join('; '), parsed.errors.map((e) => e.code)));
              } else resolve(parsed.result);
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error(`CA request to ${u.href} timed out`)));
      req.on('error', reject);
      req.end(data);
    });
  }

  async enroll(enrollmentId: string, secret: string): Promise<Credentials> {
    const { csr, privateKey } = await newKeyAndCsr(enrollmentId);
    const result = await this.request<{ Cert: string }>(
      '/api/v1/enroll',
      { certificate_request: csr, caname: this.caName },
      `Basic ${b64(`${enrollmentId}:${secret}`)}`,
    );
    return { certificate: Buffer.from(result.Cert, 'base64').toString('utf8'), privateKey };
  }

  async register(registrar: Credentials, r: RegisterRequest): Promise<string> {
    const secret = r.secret ?? randomBytes(18).toString('base64url');
    const body = {
      id: r.id,
      type: r.type ?? 'client',
      secret,
      max_enrollments: r.maxEnrollments ?? -1,
      affiliation: '',
      attrs: (r.attrs ?? []).map((a) => ({ name: a.name, value: a.value, ecert: a.ecert ?? false })),
      caname: this.caName,
    };
    const data = Buffer.from(JSON.stringify(body));
    await this.request('/api/v1/register', body, caToken(registrar, 'POST', '/api/v1/register', data));
    return secret;
  }

  async revoke(registrar: Credentials, id: string, reason = 'keycompromise'): Promise<string | null> {
    const body = { id, reason, caname: this.caName, gencrl: true };
    const data = Buffer.from(JSON.stringify(body));
    const result = await this.request<{ CRL?: string }>('/api/v1/revoke', body, caToken(registrar, 'POST', '/api/v1/revoke', data));
    return result.CRL ?? null;
  }
}

export function certFingerprint(pem: string): string {
  return createHash('sha256').update(pem).digest('hex').slice(0, 16);
}
