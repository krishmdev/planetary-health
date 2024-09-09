import path from 'node:path';
import { z } from 'zod';

export type OrgKey = 'org1' | 'org2';

interface OrgInfo {
  mspId: string;
  displayName: string;
  domain: string;
  peer: { endpoint: string; hostAlias: string; ops: string };
  ca: { url: string; name: string };
}

// Host-side defaults match the fabric-samples test network. Inside Docker the compose file
// overrides the endpoints with the service names on the fabric_test network.
export const ORGS: Record<OrgKey, OrgInfo> = {
  org1: {
    mspId: 'Org1MSP',
    displayName: 'Mercy General',
    domain: 'org1.example.com',
    peer: { endpoint: 'localhost:7051', hostAlias: 'peer0.org1.example.com', ops: 'http://localhost:9444' },
    ca: { url: 'https://localhost:7054', name: 'ca-org1' },
  },
  org2: {
    mspId: 'Org2MSP',
    displayName: 'Riverside Clinic',
    domain: 'org2.example.com',
    peer: { endpoint: 'localhost:9051', hostAlias: 'peer0.org2.example.com', ops: 'http://localhost:9445' },
    ca: { url: 'https://localhost:8054', name: 'ca-org2' },
  },
};

export interface OrdererEndpoint {
  name: string;
  endpoint: string;
  hostAlias: string;
  ops: string;
}

const DEFAULT_ORDERERS =
  'orderer.example.com=localhost:7050|http://localhost:9443,' +
  'orderer2.example.com=localhost:7052|http://localhost:9446,' +
  'orderer3.example.com=localhost:7056|http://localhost:9447,' +
  'orderer4.example.com=localhost:7058|http://localhost:9448';

export function parseOrderers(spec: string): OrdererEndpoint[] {
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [name, rest] = s.split('=');
      const [endpoint, ops] = (rest ?? '').split('|');
      if (!name || !endpoint) throw new Error(`bad orderer spec ${s}`);
      return { name, endpoint, hostAlias: name, ops: ops ?? '' };
    });
}

const Env = z.object({
  ORG: z.enum(['org1', 'org2']).default('org1'),
  PORT: z.coerce.number().int().default(8080),
  CHANNEL: z.string().default('ehrchannel'),
  CHAINCODE: z.string().default('ehr'),
  FABRIC_ORGS_DIR: z.string().optional(),
  PEER_ENDPOINT: z.string().optional(),
  PEER_HOST_ALIAS: z.string().optional(),
  PEER_OPS: z.string().optional(),
  READ_PEER_ENDPOINT: z.string().optional(),
  READ_PEER_HOST_ALIAS: z.string().optional(),
  ORDERERS: z.string().default(DEFAULT_ORDERERS),
  BFT_F: z.coerce.number().int().min(0).default(1),
  PEER_OPS_ALL: z.string().optional(),
  CA_URL: z.string().optional(),
  WALLET_DIR: z.string().optional(),
  WALLET_KEY: z.string().min(16, 'WALLET_KEY must be at least 16 characters'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  DATA_DIR: z.string().optional(),
  FRESHNESS: z.enum(['on', 'off']).default('on'),
  FRESHNESS_TIMEOUT_MS: z.coerce.number().int().default(5000),
  COMMIT_TIMEOUT_MS: z.coerce.number().int().default(60000),
  LOG_LEVEL: z.string().default('info'),
});

export interface Config {
  org: OrgKey;
  mspId: string;
  displayName: string;
  port: number;
  channel: string;
  chaincode: string;
  orgsDir: string;
  tlsRootCert: string;
  peer: { endpoint: string; hostAlias: string; ops: string };
  readPeer: { endpoint: string; hostAlias: string } | null;
  peerOps: { name: string; url: string }[];
  orderers: OrdererEndpoint[];
  ordererTlsRootCert: string;
  f: number;
  ca: { url: string; name: string; tlsCert: string };
  walletDir: string;
  walletKey: string;
  jwt: { secret: string; issuer: string; audience: string; ttlSeconds: number };
  dataDir: string;
  freshness: boolean;
  freshnessTimeoutMs: number;
  commitTimeoutMs: number;
  logLevel: string;
}

export function jwtIssuer(org: OrgKey): string {
  return `planetary-health/${org}`;
}

export function jwtAudience(org: OrgKey): string {
  return `${org}-api`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = Env.parse(env);
  const root = path.resolve(import.meta.dirname, '../..');
  const org = ORGS[e.ORG];
  const orgsDir = e.FABRIC_ORGS_DIR ?? path.join(root, '.fabric/fabric-samples/test-network/organizations');
  const peerOrgDir = path.join(orgsDir, 'peerOrganizations', org.domain);
  return {
    org: e.ORG,
    mspId: org.mspId,
    displayName: org.displayName,
    port: e.PORT,
    channel: e.CHANNEL,
    chaincode: e.CHAINCODE,
    orgsDir,
    tlsRootCert: path.join(peerOrgDir, 'tlsca', `tlsca.${org.domain}-cert.pem`),
    peer: {
      endpoint: e.PEER_ENDPOINT ?? org.peer.endpoint,
      hostAlias: e.PEER_HOST_ALIAS ?? org.peer.hostAlias,
      ops: e.PEER_OPS ?? org.peer.ops,
    },
    readPeer: e.READ_PEER_ENDPOINT
      ? { endpoint: e.READ_PEER_ENDPOINT, hostAlias: e.READ_PEER_HOST_ALIAS ?? org.peer.hostAlias }
      : null,
    peerOps: (e.PEER_OPS_ALL ?? 'peer0.org1=http://localhost:9444,peer0.org2=http://localhost:9445')
      .split(',')
      .filter(Boolean)
      .map((s) => {
        const [name, url] = s.split('=');
        return { name: name ?? s, url: url ?? '' };
      }),
    orderers: parseOrderers(e.ORDERERS),
    ordererTlsRootCert: path.join(orgsDir, 'ordererOrganizations/example.com/tlsca/tlsca.example.com-cert.pem'),
    f: e.BFT_F,
    ca: {
      url: e.CA_URL ?? org.ca.url,
      name: org.ca.name,
      tlsCert: path.join(orgsDir, 'fabric-ca', e.ORG, 'ca-cert.pem'),
    },
    walletDir: e.WALLET_DIR ?? path.join(root, '.wallet', e.ORG),
    walletKey: e.WALLET_KEY,
    jwt: { secret: e.JWT_SECRET, issuer: jwtIssuer(e.ORG), audience: jwtAudience(e.ORG), ttlSeconds: 15 * 60 },
    dataDir: e.DATA_DIR ?? path.join(root, '.data', e.ORG),
    freshness: e.FRESHNESS === 'on',
    freshnessTimeoutMs: e.FRESHNESS_TIMEOUT_MS,
    commitTimeoutMs: e.COMMIT_TIMEOUT_MS,
    logLevel: e.LOG_LEVEL,
  };
}
