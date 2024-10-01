import { SignJWT } from 'jose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { RateLimiter, Tokens } from '../src/auth.js';
import { harness, SECRET } from './fakes.js';

describe('login and JWT verification', () => {
  it('logs in with the right password and rejects the wrong one', async () => {
    const h = await harness();
    const ok = await request(h.app).post('/auth/login').send({ username: 'alice', password: 'alice-demo' });
    expect(ok.status).toBe(200);
    expect(ok.body.user).toMatchObject({ sub: 'alice', ehrId: 'P-1001', role: 'patient' });
    expect(ok.body.user.passwordHash).toBeUndefined();
    const claims = await h.tokens.verify(ok.body.token);
    expect(claims.sub).toBe('alice');

    const bad = await request(h.app).post('/auth/login').send({ username: 'alice', password: 'nope' });
    expect(bad.status).toBe(401);
    const unknown = await request(h.app).post('/auth/login').send({ username: 'mallory', password: 'x' });
    expect(unknown.status).toBe(401);
  });

  it('rejects missing, tampered and expired tokens with 401', async () => {
    const h = await harness();
    h.ledger.on('WhoAmI', (user) => ({ id: user }));
    expect((await request(h.app).get('/me')).status).toBe(401);

    const good = await h.token('alice', 'patient', 'P-1001');
    expect((await request(h.app).get('/me').set('Authorization', `Bearer ${good}`)).status).toBe(200);

    // Swap the payload to claim Ben's subject but keep Alice's signature.
    const [head, , sig] = good.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'ben', role: 'patient', ehrId: 'P-1002', org: 'Org1MSP', iss: 'planetary-health/org1', aud: 'org1-api', iat: 1, exp: 9999999999 })).toString('base64url');
    const tampered = `${head}.${forged}.${sig}`;
    expect((await request(h.app).get('/me').set('Authorization', `Bearer ${tampered}`)).status).toBe(401);

    const expired = (await h.tokens.issue({ sub: 'alice', role: 'patient', ehrId: 'P-1001', org: 'Org1MSP' }, Date.now() - 16 * 60 * 1000)).token;
    expect((await request(h.app).get('/me').set('Authorization', `Bearer ${expired}`)).status).toBe(401);

    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"alice"}').toString('base64url')}.`;
    expect((await request(h.app).get('/me').set('Authorization', `Bearer ${none}`)).status).toBe(401);
  });

  it('rejects an Org2 token at the Org1 gateway', async () => {
    const h = await harness();
    const org2 = new Tokens({ secret: 'org2-secret-that-is-at-least-32-characters', issuer: 'planetary-health/org2', audience: 'org2-api', ttlSeconds: 900 });
    const t = (await org2.issue({ sub: 'alice', role: 'patient', ehrId: 'P-1001', org: 'Org2MSP' })).token;
    expect((await request(h.app).get('/me').set('Authorization', `Bearer ${t}`)).status).toBe(401);

    // Even signed with Org1's secret, the wrong issuer/audience is refused.
    const key = new TextEncoder().encode(SECRET);
    const wrongAud = await new SignJWT({ role: 'patient', ehrId: 'P-1001', org: 'Org2MSP' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('alice')
      .setIssuer('planetary-health/org2')
      .setAudience('org2-api')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(key);
    expect((await request(h.app).get('/me').set('Authorization', `Bearer ${wrongAud}`)).status).toBe(401);
  });

  it('rejects a valid token whose subject has no wallet identity', async () => {
    const h = await harness();
    const t = await h.token('ghost', 'patient', 'P-9');
    expect((await request(h.app).get('/me').set('Authorization', `Bearer ${t}`)).status).toBe(401);
  });

  it('signs every chaincode call as the token subject, never a shared identity', async () => {
    const h = await harness();
    h.ledger.on('ListPatientRecords', () => []);
    const t = await h.token('alice', 'patient', 'P-1001');
    // Alice asks for Ben's records: the gateway passes P-1002 as data but signs as alice, so the
    // chaincode sees Alice's certificate and denies it.
    await request(h.app).get('/patients/P-1002/records').set('Authorization', `Bearer ${t}`);
    expect(h.ledger.calls.at(-1)).toMatchObject({ user: 'alice', fn: 'ListPatientRecords', args: ['P-1002'] });
  });

  it('rate-limits login attempts', async () => {
    const h = await harness();
    const codes: number[] = [];
    // Enough attempts that refill during slow scrypt checks on a loaded machine can't keep up.
    for (let i = 0; i < 20; i++) {
      codes.push((await request(h.app).post('/auth/login').send({ username: 'alice', password: 'wrong' })).status);
    }
    expect(codes).toContain(429);
    const rl = new RateLimiter(2, 1);
    expect(rl.take('x', 0)).toBe(true);
    expect(rl.take('x', 0)).toBe(true);
    expect(rl.take('x', 0)).toBe(false);
    expect(rl.take('x', 1000)).toBe(true);
  });
});
