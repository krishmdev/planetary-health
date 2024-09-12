// The narrow interface the HTTP layer uses to reach Fabric. FabricLedger implements it against
// a real peer; tests use an in-memory fake.

export interface TxReceipt {
  txId: string;
  blockNumber: string;
  status: string;
}

export type Transient = Record<string, string | Uint8Array>;

export interface ChaincodeEventMessage {
  eventName: string;
  txId: string;
  blockNumber: string;
  payload: unknown;
}

export interface EndorseProbe {
  endorsedBy: string[];
  ms: number;
}

export interface Ledger {
  // Every call is made as the wallet identity whose label is `user` (the verified JWT subject).
  evaluate<T>(user: string, fn: string, args: string[], opts?: { readPeer?: boolean }): Promise<T>;
  submit<T>(user: string, fn: string, args: string[], transient?: Transient): Promise<{ result: T; receipt: TxReceipt }>;
  // Newest block number on the channel as reported by the ordering service.
  ordererBoundary(user: string): Promise<bigint>;
  // Resolves once the (read) peer has committed `block`, rejects with FreshnessTimeout otherwise.
  waitForPeerBlock(user: string, block: bigint, timeoutMs: number, opts?: { readPeer?: boolean }): Promise<void>;
  endorseProbe(user: string): Promise<EndorseProbe>;
  chaincodeEvents(user: string, onEvent: (e: ChaincodeEventMessage) => void): Promise<() => void>;
  close(): void;
}

export class FreshnessTimeout extends Error {
  constructor(
    readonly target: bigint,
    readonly timeoutMs: number,
  ) {
    super(`peer did not commit block ${target} within ${timeoutMs} ms`);
    this.name = 'FreshnessTimeout';
  }
}

export class OrderingUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderingUnavailable';
  }
}

export class CommitFailed extends Error {
  constructor(
    readonly txId: string,
    readonly status: string,
    readonly blockNumber: string,
  ) {
    super(`transaction ${txId} committed as ${status} in block ${blockNumber}`);
    this.name = 'CommitFailed';
  }
}
