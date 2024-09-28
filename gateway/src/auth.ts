import type { NextFunction, Request, Response } from 'express';
import { jwtVerify, SignJWT } from 'jose';
import type { Role } from './users.js';

export interface Claims {
  sub: string;
  role: Role;
  ehrId: string;
  org: string;
  exp: number;
}

export interface JwtSettings {
  secret: string;
  issuer: string;
  audience: string;
  ttlSeconds: number;
}

declare global {
  namespace Express {
    interface Request {
      user?: Claims;
    }
  }
}

export class Tokens {
  private key: Uint8Array;

  constructor(private settings: JwtSettings) {
    this.key = new TextEncoder().encode(settings.secret);
  }

  async issue(c: Omit<Claims, 'exp'>, now = Date.now()): Promise<{ token: string; expiresAt: string }> {
    const iat = Math.floor(now / 1000);
    const exp = iat + this.settings.ttlSeconds;
    const token = await new SignJWT({ role: c.role, ehrId: c.ehrId, org: c.org })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(c.sub)
      .setIssuer(this.settings.issuer)
      .setAudience(this.settings.audience)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(this.key);
    return { token, expiresAt: new Date(exp * 1000).toISOString() };
  }

  // Signature, algorithm, issuer, audience and expiry must all check out. A token from the
  // other hospital fails on the secret and on iss/aud.
  async verify(token: string): Promise<Claims> {
    const { payload } = await jwtVerify(token, this.key, {
      algorithms: ['HS256'],
      issuer: this.settings.issuer,
      audience: this.settings.audience,
      requiredClaims: ['sub', 'exp', 'iat'],
    });
    const { sub, role, ehrId, org, exp } = payload as Record<string, unknown>;
    if (typeof sub !== 'string' || typeof role !== 'string' || typeof ehrId !== 'string' || typeof org !== 'string' || typeof exp !== 'number') {
      throw new Error('malformed claims');
    }
    return { sub, role: role as Role, ehrId, org, exp };
  }
}

function bearer(req: Request, allowQuery: boolean): string | null {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7).trim();
  // EventSource can't set headers, so the SSE route alone accepts ?token=.
  if (allowQuery && typeof req.query.token === 'string') return req.query.token;
  return null;
}

export function requireAuth(tokens: Tokens, hasIdentity: (sub: string) => boolean, allowQuery = false) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = bearer(req, allowQuery);
    if (!token) {
      res.status(401).json({ error: 'UNAUTHENTICATED', message: 'missing bearer token' });
      return;
    }
    try {
      const claims = await tokens.verify(token);
      if (!hasIdentity(claims.sub)) throw new Error('no wallet identity');
      req.user = claims;
      next();
    } catch {
      res.status(401).json({ error: 'UNAUTHENTICATED', message: 'invalid or expired token' });
    }
  };
}

// Token bucket per key (client IP for login).
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private capacity: number,
    private refillPerSec: number,
  ) {}

  take(key: string, now = Date.now()): boolean {
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.at) / 1000) * this.refillPerSec);
    b.at = now;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) this.buckets.clear();
    return ok;
  }
}
