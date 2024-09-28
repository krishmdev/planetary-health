import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Custodial per-user wallet. One file per enrolled identity, named by its label (the login
// subject). Private keys are encrypted with AES-256-GCM under a key derived from the gateway's
// master key. The label, MSP ID and certificate are bound in as associated data, so a key can't be
// moved to another user's file or paired with a different certificate.

export interface WalletIdentity {
  label: string;
  mspId: string;
  certificate: string;
  privateKey: string;
}

interface StoredIdentity {
  version: 1;
  label: string;
  mspId: string;
  certificate: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

interface WalletMeta {
  version: 1;
  salt: string;
}

function aad(label: string, mspId: string, certificate: string): Buffer {
  return Buffer.from(`${label}\n${mspId}\n${certificate}`);
}

const LABEL = /^[a-z0-9][a-z0-9._-]{1,63}$/;

export class Wallet {
  private key: Buffer;
  private cache = new Map<string, WalletIdentity>();

  constructor(
    readonly dir: string,
    masterKey: string,
  ) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const metaPath = path.join(dir, 'wallet.json');
    let meta: WalletMeta;
    if (fs.existsSync(metaPath)) {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as WalletMeta;
    } else {
      meta = { version: 1, salt: randomBytes(16).toString('base64') };
      fs.writeFileSync(metaPath, JSON.stringify(meta), { mode: 0o600 });
    }
    this.key = scryptSync(masterKey, Buffer.from(meta.salt, 'base64'), 32);
  }

  private file(label: string): string {
    if (!LABEL.test(label)) throw new Error(`invalid wallet label ${JSON.stringify(label)}`);
    return path.join(this.dir, `${label}.id`);
  }

  put(id: WalletIdentity): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(aad(id.label, id.mspId, id.certificate));
    const ciphertext = Buffer.concat([cipher.update(id.privateKey, 'utf8'), cipher.final()]);
    const stored: StoredIdentity = {
      version: 1,
      label: id.label,
      mspId: id.mspId,
      certificate: id.certificate,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
    const target = this.file(id.label);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(stored), { mode: 0o600 });
    fs.renameSync(tmp, target);
    this.cache.set(id.label, id);
  }

  has(label: string): boolean {
    return LABEL.test(label) && fs.existsSync(this.file(label));
  }

  get(label: string): WalletIdentity | null {
    const hit = this.cache.get(label);
    if (hit) return hit;
    if (!this.has(label)) return null;
    const stored = JSON.parse(fs.readFileSync(this.file(label), 'utf8')) as StoredIdentity;
    if (stored.label !== label) throw new Error(`wallet file for ${label} is labelled ${stored.label}`);
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(stored.iv, 'base64'));
    decipher.setAAD(aad(label, stored.mspId, stored.certificate));
    decipher.setAuthTag(Buffer.from(stored.tag, 'base64'));
    const privateKey = Buffer.concat([
      decipher.update(Buffer.from(stored.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    const id = { label, mspId: stored.mspId, certificate: stored.certificate, privateKey };
    this.cache.set(label, id);
    return id;
  }

  remove(label: string): void {
    this.cache.delete(label);
    if (this.has(label)) fs.rmSync(this.file(label));
  }

  list(): string[] {
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.id'))
      .map((f) => f.slice(0, -3));
  }
}
