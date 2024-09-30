export type OrgKey = 'org1' | 'org2';

export const ORGS: Record<OrgKey, { name: string; msp: string; short: string }> = {
  org1: { name: 'Mercy General', msp: 'Org1MSP', short: 'Mercy' },
  org2: { name: 'Riverside Clinic', msp: 'Org2MSP', short: 'Riverside' },
};

export type Role = 'patient' | 'doctor' | 'admin';

export interface User {
  sub: string;
  ehrId: string;
  role: Role;
  displayName: string;
  specialty?: string;
}

export interface Receipt {
  txId: string;
  blockNumber: string;
  status: string;
}

export interface RecordMeta {
  recordId: string;
  patientId: string;
  type: string;
  createdBy: string;
  org: string;
  createdAt: string;
  phiSha256: string;
  version: number;
  purgeRequested: boolean;
  purged: boolean;
}

export interface Consent {
  consentId: string;
  patientId: string;
  grantee: string;
  types: string[];
  actions: string[];
  purpose: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
}

export interface Member {
  id: string;
  role: Role;
  org: string;
  enrollmentId: string;
  specialty?: string;
  active: boolean;
}

export interface AccessGrant {
  accessId: string;
  patientId: string;
  recordId: string;
  recordType: string;
  actor: string;
  actorOrg: string;
  role: string;
  purpose: string;
  basis: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  deliveredAt?: string;
}

export interface BreakGlass {
  grantId: string;
  patientId: string;
  providerId: string;
  providerOrg: string;
  patientOrg: string;
  reason: string;
  createdAt: string;
  expiresAt: string;
  reviewed: boolean;
  outcome?: string;
}

export interface Delivery {
  record: { accessId: string; recordId: string; patientId: string; type: string; phi: string; phiSha256: string; basis: string };
  freshness: { grantBlock: string | null; ordererNewest: string; waitedForBlock: string; waitMs: number; enforced: boolean };
  receipt: 'pending' | 'recorded';
  grant: AccessGrant;
  grantReceipt: Receipt;
}

export interface NodeHealth {
  name: string;
  up: boolean;
  status?: string;
  height?: number;
  leader?: number;
  ms: number;
}

export interface NetworkStatus {
  org: string;
  channel: string;
  orderers: NodeHealth[];
  peers: NodeHealth[];
  bftLeader: number | null;
  ordererHeight: number | null;
  quorum: { live: number; needed: number; total: number; ok: boolean };
  checkedAt: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter: number | null,
  ) {
    super(message);
  }
}

// Gateway reachability, shared by every request: the app shows one page-level banner when
// requests keep failing to reach the gateway instead of an error block in every card.
const KNOWN_503 = new Set(['STALE_PEER', 'ORDERING_QUORUM_LOST', 'ORDERING_UNAVAILABLE', 'FABRIC_UNAVAILABLE', 'PHI_UNAVAILABLE', 'WAKE_TIMEOUT', 'WAKE_FAILED', 'ACTIVATION_QUEUE_FULL']);

export function isUnreachable(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 0 || ([502, 503, 504].includes(e.status) && !KNOWN_503.has(e.code)));
}

type Listener = (failures: number) => void;
let failures = 0;
const listeners = new Set<Listener>();
export const reachability = {
  subscribe(l: Listener) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get failures() {
    return failures;
  },
};
function report(ok: boolean) {
  const next = ok ? 0 : failures + 1;
  if (next !== failures) {
    failures = next;
    for (const l of listeners) l(failures);
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function request<T>(org: OrgKey, token: string | null, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/${org}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    report(false);
    throw new ApiError(0, 'NETWORK', `Can't reach the ${ORGS[org].name} gateway.`, null);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text };
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; message?: string };
    if (res.status === 401 && token) onUnauthorized?.();
    const ra = res.headers.get('retry-after');
    const err = new ApiError(res.status, d.error ?? `HTTP_${res.status}`, d.message ?? res.statusText, ra ? Number(ra) : null);
    report(!isUnreachable(err));
    throw err;
  }
  report(true);
  return data as T;
}
