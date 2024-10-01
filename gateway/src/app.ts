import express, { type NextFunction, type Request, type Response } from 'express';
import type { Logger } from 'pino';
import { z } from 'zod';
import { RateLimiter, requireAuth, type Tokens } from './auth.js';
import { type DeliveryStore, ReplayError } from './deliveries.js';
import type { FabricCA } from './fabric/ca.js';
import { toHttpError } from './fabric/errors.js';
import type { ChaincodeEventMessage, Ledger } from './fabric/ledger.js';
import { sealPhi } from './envelope.js';
import { type Fetcher, networkStatus } from './network.js';
import type { PhiService } from './phi.js';
import { hashPassword, publicUser, type UserStore } from './users.js';
import type { Wallet } from './wallet.js';

export interface AppDeps {
  org: string;
  mspId: string;
  displayName: string;
  channel: string;
  f: number;
  orderers: { name: string; ops: string }[];
  peers: { name: string; url: string }[];
  ledger: Ledger;
  wallet: Pick<Wallet, 'has' | 'get' | 'put' | 'remove'>;
  users: UserStore;
  tokens: Tokens;
  phi: PhiService;
  deliveries: DeliveryStore;
  ca?: FabricCA;
  fetcher: Fetcher;
  log: Logger;
  probeIdentity?: string;
  trustProxy?: string | false;
}

class BadRequest extends Error {}

function body<T>(schema: z.ZodType<T>, req: Request): T {
  const r = schema.safeParse(req.body);
  if (!r.success) throw new BadRequest(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}

function sendError(res: Response, err: unknown, log: Logger): void {
  if (err instanceof BadRequest) {
    res.status(400).json({ error: 'BAD_REQUEST', message: err.message });
    return;
  }
  if (err instanceof ReplayError) {
    res.status(409).json({ error: 'GRANT_ALREADY_USED', message: err.message });
    return;
  }
  const e = toHttpError(err);
  if (e.status >= 500) log.warn({ err: e.body }, 'request failed');
  if (e.retryAfter) res.setHeader('Retry-After', String(e.retryAfter));
  const freshness = (err as { freshness?: unknown } | null)?.freshness;
  res.status(e.status).json(freshness ? { ...e.body, freshness } : e.body);
}

type Handler = (req: Request, res: Response) => Promise<unknown>;

const RecordTypes = z.enum(['lab', 'imaging', 'note', 'rx', 'allergy']);
const Id = z.string().regex(/^[A-Za-z0-9_-]{3,40}$/);

export function createApp(d: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // Behind the activator (compose sets TRUST_PROXY) the client address comes from
  // X-Forwarded-For; reached directly, the header is ignored so it can't dodge the login limit.
  app.set('trust proxy', d.trustProxy ?? false);
  app.use(express.json({ limit: '128kb' }));

  const wrap =
    (h: Handler) =>
    async (req: Request, res: Response): Promise<void> => {
      try {
        const out = await h(req, res);
        if (!res.headersSent) res.json(out);
      } catch (err) {
        sendError(res, err, d.log);
      }
    };

  const auth = requireAuth(d.tokens, (sub) => d.wallet.has(sub));
  const sub = (req: Request) => req.user!.sub;
  const loginLimiter = new RateLimiter(5, 0.5);
  const submit = async (req: Request, fn: string, args: string[]) => {
    const { result, receipt } = await d.ledger.submit(sub(req), fn, args);
    return { result, receipt };
  };

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, org: d.org });
  });

  // Deep readiness: ordering-service boundary, this org's peer caught up to it, and a real
  // (unsubmitted) endorsement of Ping by both orgs. The activator waits on this.
  app.get(
    '/readyz',
    wrap(async (_req, res) => {
      const probe = d.probeIdentity ?? 'probe';
      const t0 = performance.now();
      try {
        const boundary = await d.ledger.ordererBoundary(probe);
        await d.ledger.waitForPeerBlock(probe, boundary, 10_000, { readPeer: false });
        const endorse = await d.ledger.endorseProbe(probe);
        return { ok: true, boundary: boundary.toString(), endorsedBy: endorse.endorsedBy, ms: Math.round(performance.now() - t0) };
      } catch (err) {
        const e = toHttpError(err);
        res.status(503).json({ ok: false, error: e.body.error, message: e.body.message });
        return undefined;
      }
    }),
  );

  app.post(
    '/auth/login',
    wrap(async (req, res) => {
      if (!loginLimiter.take(req.ip ?? 'unknown')) {
        res.setHeader('Retry-After', '2');
        res.status(429).json({ error: 'RATE_LIMITED', message: 'too many login attempts' });
        return undefined;
      }
      const { username, password } = body(z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) }), req);
      const user = await d.users.authenticate(username, password);
      if (!user || !d.wallet.has(user.sub)) {
        res.status(401).json({ error: 'UNAUTHENTICATED', message: 'unknown user or wrong password' });
        return undefined;
      }
      const t = await d.tokens.issue({ sub: user.sub, role: user.role, ehrId: user.ehrId, org: d.mspId });
      return { ...t, user: publicUser(user), org: { key: d.org, mspId: d.mspId, name: d.displayName } };
    }),
  );

  app.get(
    '/me',
    auth,
    wrap(async (req) => {
      const onChain = await d.ledger.evaluate(sub(req), 'WhoAmI', []);
      const u = d.users.get(sub(req));
      return { user: u ? publicUser(u) : null, onChain, org: { key: d.org, mspId: d.mspId, name: d.displayName } };
    }),
  );

  app.get('/providers', auth, wrap(async (req) => d.ledger.evaluate(sub(req), 'ListProviders', [])));
  app.get('/members/:id', auth, wrap(async (req) => d.ledger.evaluate(sub(req), 'GetMember', [String(req.params.id)])));

  // Records. PHI goes only into the transient map; the response is public metadata.
  app.get('/patients/:pid/records', auth, wrap(async (req) => d.ledger.evaluate(sub(req), 'ListPatientRecords', [String(req.params.pid)])));
  app.post(
    '/patients/:pid/records',
    auth,
    wrap(async (req) => {
      const b = body(z.object({ type: RecordTypes, phi: z.union([z.string().min(1), z.record(z.string(), z.unknown())]) }), req);
      const phi = typeof b.phi === 'string' ? b.phi : JSON.stringify(b.phi);
      const { result, receipt } = await d.ledger.submit(sub(req), 'CreateRecord', [String(req.params.pid), b.type], {
        phi: sealPhi(phi),
      });
      return { record: result, receipt };
    }),
  );
  app.get('/records/:rid', auth, wrap(async (req) => d.ledger.evaluate(sub(req), 'GetRecordMeta', [String(req.params.rid)])));
  app.get('/records/:rid/history', auth, wrap(async (req) => d.ledger.evaluate(sub(req), 'GetRecordHistory', [String(req.params.rid)])));
  app.post(
    '/records/:rid/verify',
    auth,
    wrap(async (req) => {
      const b = body(z.object({ sha256: z.string().regex(/^[0-9a-fA-F]{64}$/) }), req);
      return d.ledger.evaluate(sub(req), 'VerifyRecordIntegrity', [String(req.params.rid), b.sha256]);
    }),
  );

  // PHI: grant (submit) then delivery (freshness wait + evaluate + single-use consume).
  app.post(
    '/records/:rid/access',
    auth,
    wrap(async (req) => {
      const b = body(z.object({ purpose: z.string().min(3).max(200) }), req);
      return d.phi.grant(sub(req), String(req.params.rid), b.purpose);
    }),
  );
  // POST because a delivery consumes the grant.
  app.post('/access/:accessId/deliver', auth, wrap(async (req) => d.phi.deliver(sub(req), String(req.params.accessId))));
  app.post(
    '/records/:rid/read',
    auth,
    wrap(async (req) => {
      const b = body(z.object({ purpose: z.string().min(3).max(200) }), req);
      return d.phi.readRecord(sub(req), String(req.params.rid), b.purpose);
    }),
  );
  app.post('/records/:rid/purge-request', auth, wrap(async (req) => submit(req, 'RequestRecordPurge', [String(req.params.rid)])));
  app.post('/records/:rid/purge', auth, wrap(async (req) => submit(req, 'PurgeRecordPHI', [String(req.params.rid)])));

  // Consent
  app.get('/consents', auth, wrap(async (req) => d.ledger.evaluate(sub(req), 'ListMyConsents', [])));
  app.post(
    '/consents',
    auth,
    wrap(async (req) => {
      const b = body(
        z.object({
          grantee: Id,
          types: z.array(z.union([RecordTypes, z.literal('*')])).min(1),
          actions: z.array(z.enum(['read', 'append'])).min(1),
          purpose: z.string().min(3).max(200),
          expiresAt: z.iso.datetime(),
        }),
        req,
      );
      return submit(req, 'GrantConsent', [b.grantee, JSON.stringify(b.types), JSON.stringify(b.actions), b.purpose, b.expiresAt]);
    }),
  );
  app.delete('/consents/:cid', auth, wrap(async (req) => submit(req, 'RevokeConsent', [String(req.params.cid)])));
  app.get('/consents/:cid/history', auth, wrap(async (req) => d.ledger.evaluate(sub(req), 'GetConsentHistory', [String(req.params.cid)])));
  app.post('/access-grants/revoke', auth, wrap(async (req) => submit(req, 'RevokeAccessGrants', [])));

  // Break-glass
  app.post(
    '/emergency',
    auth,
    wrap(async (req) => {
      const b = body(z.object({ patientId: Id, reason: z.string().min(10).max(500) }), req);
      return submit(req, 'RequestEmergencyAccess', [b.patientId, b.reason]);
    }),
  );
  app.get('/emergency/reviews', auth, wrap(async (req) => d.ledger.evaluate(sub(req), 'ListPendingEmergencyReviews', [])));
  app.post(
    '/emergency/:gid/review',
    auth,
    wrap(async (req) => {
      const b = body(z.object({ outcome: z.enum(['justified', 'unjustified']), note: z.string().max(500).default('') }), req);
      return submit(req, 'ReviewEmergencyAccess', [String(req.params.gid), b.outcome, b.note]);
    }),
  );

  // Audit
  app.get('/audit/:pid', auth, wrap(async (req) => d.ledger.evaluate(sub(req), 'GetAccessLog', [String(req.params.pid)])));
  app.get(
    '/audit/:pid/reconcile',
    auth,
    wrap(async (req) => {
      const pid = String(req.params.pid);
      const report = await d.ledger.evaluate<{ grants: { accessId: string; status: string }[] }>(sub(req), 'AuditReconcile', [pid]);
      const onLedger = new Map(report.grants.map((g) => [g.accessId, g.status]));
      const local = d.deliveries.forPatient(pid);
      const missingReceipts = local
        .filter((row) => onLedger.get(row.access_id) !== 'delivered')
        .map((row) => ({ accessId: row.access_id, consumedAt: row.consumed_at, localReceiptState: row.receipt_state, lastError: row.last_error }));
      return { ...report, gateway: d.org, localDeliveries: local.length, missingReceipts };
    }),
  );

  // Registry administration (admin only, checked on-chain via the caller's certificate).
  const requireChainAdmin = async (req: Request) => {
    const who = await d.ledger.evaluate<{ role: string; id: string }>(sub(req), 'WhoAmI', []);
    if (who.role !== 'admin') throw new Error('ACCESS_DENIED: administrators only');
    return who;
  };
  app.get('/admin/members', auth, wrap(async (req) => d.ledger.evaluate(sub(req), 'ListOrgMembers', [])));
  app.post(
    '/admin/users',
    auth,
    wrap(async (req) => {
      const b = body(
        z.object({
          username: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/),
          displayName: z.string().min(1).max(80),
          role: z.enum(['patient', 'doctor', 'admin']),
          ehrId: Id,
          password: z.string().min(8).max(256),
          specialty: z.string().max(80).optional(),
        }),
        req,
      );
      await requireChainAdmin(req);
      if (!d.ca) throw new Error('no CA registrar configured for this gateway');
      const registrar = d.wallet.get('ca-registrar');
      if (!registrar) throw new Error('CA registrar identity missing from the wallet');
      if (d.wallet.has(b.username)) throw new BadRequest(`${b.username} already has a wallet identity`);
      const secret = await d.ca.register(registrar, {
        id: b.username,
        type: 'client',
        attrs: [
          { name: 'ehr.role', value: b.role, ecert: true },
          { name: 'ehr.id', value: b.ehrId, ecert: true },
        ],
      });
      const fn = { patient: 'RegisterPatient', doctor: 'RegisterProvider', admin: 'RegisterAdmin' }[b.role];
      const args = b.role === 'doctor' ? [b.ehrId, b.username, b.specialty ?? ''] : [b.ehrId, b.username];
      let result: unknown;
      let receipt: unknown;
      try {
        const creds = await d.ca.enroll(b.username, secret);
        d.wallet.put({ label: b.username, mspId: d.mspId, ...creds });
        ({ result, receipt } = await d.ledger.submit(sub(req), fn, args));
      } catch (err) {
        // Only undo on a definitive failure (endorsement refused, or committed as invalid). After
        // an ambiguous one (timeout, ordering unavailable) the registry entry may still commit,
        // so the identity is kept and the admin can retry the chain step. Fabric CA keeps the
        // revoked registration, so a compensated username can't be reused.
        const e = toHttpError(err);
        if (e.status < 500 || e.body.error === 'COMMIT_FAILED') {
          d.wallet.remove(b.username);
          await d.ca.revoke(registrar, b.username).catch((ce: Error) => d.log.warn({ user: b.username, err: ce.message }, 'could not revoke orphaned CA identity'));
        } else {
          d.log.warn({ user: b.username, err: e.body }, 'registry write outcome unknown; keeping the new identity');
        }
        throw err;
      }
      d.users.upsert({
        sub: b.username,
        ehrId: b.ehrId,
        role: b.role,
        displayName: b.displayName,
        specialty: b.specialty,
        passwordHash: await hashPassword(b.password),
      });
      return { member: result, receipt };
    }),
  );
  app.post('/admin/members/:id/deactivate', auth, wrap(async (req) => submit(req, 'DeactivateUser', [String(req.params.id)])));
  app.post(
    '/admin/providers/:id/active',
    auth,
    wrap(async (req) => {
      const b = body(z.object({ active: z.boolean() }), req);
      return submit(req, 'SetProviderActive', [String(req.params.id), String(b.active)]);
    }),
  );

  app.get(
    '/network/status',
    auth,
    wrap(async () => ({ org: d.org, ...(await networkStatus(d.fetcher, d.channel, d.orderers, d.peers, d.f)) })),
  );

  // Server-sent chaincode events, filtered to what the caller may see. Payloads never hold PHI.
  app.get('/events', requireAuth(d.tokens, (s) => d.wallet.has(s), true), async (req, res) => {
    const claims = req.user!;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': connected\n\n');
    const orgPatients = new Set(d.users.all().filter((u) => u.role === 'patient').map((u) => u.ehrId));
    const visible = (e: ChaincodeEventMessage) => eventVisible(e, claims.role, claims.ehrId, d.mspId, orgPatients);
    let close: (() => void) | null = null;
    try {
      close = await d.ledger.chaincodeEvents(claims.sub, (e) => {
        if (visible(e)) res.write(`event: chaincode\ndata: ${JSON.stringify(e)}\n\n`);
      });
    } catch (err) {
      res.write(`event: error\ndata: ${JSON.stringify(toHttpError(err).body)}\n\n`);
      res.end();
      return;
    }
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    // The stream ends when the token does; the client has to log in again to reconnect, which
    // also re-checks the account.
    const expiry = setTimeout(() => res.end(), Math.max(0, claims.exp * 1000 - Date.now()));
    req.on('close', () => {
      clearInterval(ping);
      clearTimeout(expiry);
      close?.();
    });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'NOT_FOUND', message: 'no such route' });
  });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof SyntaxError) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'malformed JSON' });
      return;
    }
    sendError(res, err, d.log);
  });
  return app;
}

export function eventVisible(e: ChaincodeEventMessage, role: string, ehrId: string, mspId: string, orgPatients: Set<string>): boolean {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  if (role === 'admin') {
    // Only events about this hospital's own patients or members; another org's break-glass
    // reasons and access purposes stay with that org.
    if (typeof p.patientId === 'string') return orgPatients.has(p.patientId);
    return p.org === mspId;
  }
  const ids = ['patientId', 'providerId', 'actor', 'grantee', 'createdBy', 'id'].map((k) => p[k]).filter((v) => typeof v === 'string');
  return ids.includes(ehrId);
}
