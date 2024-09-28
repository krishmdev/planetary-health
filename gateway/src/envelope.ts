import { randomBytes } from 'node:crypto';

// PHI is stored as {salt, data}. The public SHA-256 covers the salt, so a channel member who
// guesses low-entropy content can't confirm the guess by hashing it.
export function sealPhi(phi: string): Buffer {
  return Buffer.from(JSON.stringify({ salt: randomBytes(32).toString('base64'), data: phi }), 'utf8');
}

export function openPhi(stored: string): string {
  try {
    const e = JSON.parse(stored) as { salt?: unknown; data?: unknown };
    if (typeof e.salt === 'string' && typeof e.data === 'string') return e.data;
  } catch {
    // not an envelope
  }
  return stored;
}
