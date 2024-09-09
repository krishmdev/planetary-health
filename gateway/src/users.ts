import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

export type Role = 'patient' | 'doctor' | 'admin';

export interface UserRecord {
  sub: string;
  ehrId: string;
  role: Role;
  displayName: string;
  passwordHash: string;
  specialty?: string;
}

export type PublicUser = Omit<UserRecord, 'passwordHash'>;

const N = 16384;
const R = 8;
const P = 1;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const got = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

// A dummy hash so logins for unknown users take as long as logins with a wrong password.
let dummyHash: Promise<string> | null = null;

// The org's login directory. It sits next to the wallet and holds no keys.
export class UserStore {
  private file: string;

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, 'users.json');
  }

  all(): UserRecord[] {
    if (!fs.existsSync(this.file)) return [];
    return JSON.parse(fs.readFileSync(this.file, 'utf8')) as UserRecord[];
  }

  get(sub: string): UserRecord | undefined {
    return this.all().find((u) => u.sub === sub);
  }

  upsert(user: UserRecord): void {
    const users = this.all().filter((u) => u.sub !== user.sub);
    users.push(user);
    users.sort((a, b) => a.sub.localeCompare(b.sub));
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(users, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  async authenticate(sub: string, password: string): Promise<UserRecord | null> {
    const user = this.get(sub);
    if (!user) {
      dummyHash ??= hashPassword('not-a-user');
      await verifyPassword(password, await dummyHash);
      return null;
    }
    return (await verifyPassword(password, user.passwordHash)) ? user : null;
  }
}

export function publicUser(u: UserRecord): PublicUser {
  const { passwordHash: _omit, ...rest } = u;
  return rest;
}
