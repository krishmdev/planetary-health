import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './app.js';
import { Tokens } from './auth.js';
import { loadConfig } from './config.js';
import { DeliveryStore } from './deliveries.js';
import { FabricCA } from './fabric/ca.js';
import { FabricLedger } from './fabric/client.js';
import { logger } from './log.js';
import { httpFetch } from './network.js';
import { PhiService } from './phi.js';
import { UserStore } from './users.js';
import { Wallet } from './wallet.js';

const cfg = loadConfig();
const log = logger(cfg.logLevel);
const wallet = new Wallet(cfg.walletDir, cfg.walletKey);
const ledger = new FabricLedger(cfg, wallet);
const deliveries = new DeliveryStore(path.join(cfg.dataDir, 'deliveries.sqlite'));
const phi = new PhiService(ledger, deliveries, { freshness: cfg.freshness, freshnessTimeoutMs: cfg.freshnessTimeoutMs }, log);
const ca = fs.existsSync(cfg.ca.tlsCert) ? new FabricCA(cfg.ca.url, cfg.ca.name, fs.readFileSync(cfg.ca.tlsCert)) : undefined;

const app = createApp({
  org: cfg.org,
  mspId: cfg.mspId,
  displayName: cfg.displayName,
  channel: cfg.channel,
  f: cfg.f,
  orderers: cfg.orderers.map((o) => ({ name: o.name, ops: o.ops })),
  peers: cfg.peerOps,
  ledger,
  wallet,
  users: new UserStore(cfg.walletDir),
  tokens: new Tokens(cfg.jwt),
  phi,
  deliveries,
  ca,
  fetcher: httpFetch,
  log,
});

phi.startOutbox();
const server = app.listen(cfg.port, () => {
  log.info({ port: cfg.port, peer: cfg.peer.endpoint, readPeer: cfg.readPeer?.endpoint ?? null, freshness: cfg.freshness }, 'gateway listening');
});

function shutdown() {
  phi.stop();
  server.close(() => {
    ledger.close();
    deliveries.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
