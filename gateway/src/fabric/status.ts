import { peer } from '@hyperledger/fabric-protos';

// Commit status code → name, e.g. 11 → MVCC_READ_CONFLICT.
export const StatusNames: Record<number, string> = Object.fromEntries(
  Object.entries(peer.TxValidationCode).map(([name, code]) => [code as number, name]),
);
