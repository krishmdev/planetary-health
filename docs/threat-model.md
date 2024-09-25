# Threat model

What the system is trying to guarantee, who is trusted for what, and where the guarantees stop.
It is a local demo on one machine with synthetic data; this document describes the design, not
a production deployment.

## Parties

| Party | Trusted for | Not trusted for |
|---|---|---|
| Patient, doctor, admin | their own actions | anything the policy doesn't grant them |
| An org's gateway (Mercy or Riverside) | holding its own users' keys; single-use PHI delivery; evaluate-time timestamps | writing state the other org hasn't endorsed |
| An org's peers | their own copy of state and private data | anything the other org's peer must also sign |
| Ordering service (4 SmartBFT orderers) | at most f = 1 faulty (crashed or Byzantine) | more than one faulty orderer |
| Activator | waking containers | anything else; it has the Docker socket, which is root-equivalent on the host |

## Identity binding

- Every user has their own X.509 certificate from their org's Fabric CA, with `ehr.role` and
  `ehr.id` as enrollment-certificate attributes.
- The gateway keeps each user's key in a custodial wallet. Files are `0600`, and each key is
  encrypted with AES-256-GCM under a key derived (scrypt) from the gateway's master key. The
  label, MSP ID and certificate are the associated data.
- The gateway signs each proposal as the wallet identity named by the verified JWT `sub`.
  There is no shared signing identity.
- The chaincode takes the caller's identity from `cid` only. No transaction takes an identity
  or role argument. The registry entry for that `ehr.id` must exist for the certificate's role,
  match its MSP, be bound to the same enrollment ID (certificate CN), and be active.
- Custodial keys are a demo simplification. A compromised gateway host can sign as any of that
  org's users. Production would use an HSM or client-side signing.
- JWTs are HS256 with per-org secrets, issuers and audiences, and expire after 15 minutes. The
  activator verifies them before waking anything, so it holds both orgs' verification secrets.
  ES256 would let the activator hold public keys only; that change is not made here.

## Writes

- The endorsement policy is MAJORITY of Org1 and Org2, so both hospitals' peers run the access
  policy on every write. A compromised gateway at one hospital cannot write a consent, access
  grant or record that the other hospital's policy check rejects.
- Fabric does not validate proposal timestamps. Each endorser therefore rejects consent
  grant/revoke, `RequestAccess` and break-glass writes whose timestamp is more than 120 s from
  its own clock. Without this, one org could backdate a grant and the other org would still
  endorse it.

## PHI reads: grants on the ledger, deliveries at the gateway

A submit's response payload is written into the block, and an evaluate does not commit. So a
read cannot atomically consume an on-ledger authorization and return PHI. The design splits it:

1. `RequestAccess` (submit, MAJORITY-endorsed) re-runs the policy and writes an `AccessGrant`:
   actor certificate, record, basis, 5-minute expiry, nonce.
2. The gateway reads a boundary block from the ordering service (below). It waits until the read
   peer has committed through `max(boundary, grant block)`, with a 5 s timeout, then 503.
3. `ReadRecordPHI` is sent as a signed proposal directly to the read peer's Endorser. It is not
   sent through the Fabric gateway service, which could route it to a different peer. It
   re-checks the grant holder, expiry, on-ledger use, and the current consent. It hashes the
   private data it is about to return and compares that to the on-ledger digest; the peer's
   private-data hash is a second check.
4. The gateway inserts the `accessId` into an append-only SQLite table with a primary key before
   returning PHI, so a second use returns 409.
5. It submits a `RecordDelivery` receipt, retried from an outbox. `AuditReconcile` flags local
   deliveries with no receipt on the ledger.

What the ledger guarantees: an endorsed, immutable record of every grant (who, what, why, when)
and a best-effort receipt for each delivery. What it does not guarantee: delivery counts. Those
are trusted to each org's gateway. A malicious operator of one hospital's gateway or peer can
replay evaluations or read its own peer's private data store directly.

Evaluate-time checks (grant expiry, consent expiry) use the proposal timestamp. The org's own
gateway sets it, which is inside the trust boundary above.

## Freshness: why a read can't miss an already-committed revocation

- A grant is fresh by construction. `RequestAccess` reads the consent and break-glass keys by
  range query during simulation. If a revocation commits first, validation marks the grant
  `PHANTOM_READ_CONFLICT` or `MVCC_READ_CONFLICT`, and the gateway only uses VALID grants. The e2e
  has a live test: a grant endorsed before a revocation but ordered after it gets 409, then 403
  on retry.
- The read boundary comes from the ordering service, not from a peer. The gateway sends a
  signed Deliver `SeekNewest` to all 4 orderers, waits for n−f = 3 answers, and takes the
  (f+1)-th largest, i.e. the second largest.
  - With at most one Byzantine orderer, that value is not above an honest orderer's height. A
    liar therefore cannot inflate the boundary and make every read (and the activator's
    readiness check) fail with 503.
  - The value is also at least the height of one honest orderer that answered.
- The residual window, stated plainly: the second-largest answer can come from an honest orderer
  that is a few milliseconds behind its peers while it writes a block. A revocation in exactly
  that newest block could then fall just outside the boundary. This is the same kind of exposure
  as the concurrent case below, and is bounded the same way. Block signatures on the Deliver
  replies are not verified, and strict Byzantine-safe freshness is not claimed.
- Concurrent revocations are bounded, not retroactive. A revocation committed at or below the
  boundary is always honored. One ordered after the boundary but before the bytes leave the
  gateway may lose the race. The exposure is at most one delivery per grant, inside the grant's
  5-minute window. Patients can also cancel outstanding grants (`RevokeAccessGrants`).
- A lagging peer never serves stale data. If the read peer does not catch up within 5 s, the
  gateway returns 503 `STALE_PEER` with Retry-After. The e2e pauses the `peer1.org1` read
  replica to test this. A `FRESHNESS=off` gateway is the negative control and must serve the
  revoked read.
- If the read peer doesn't hold the private data yet (dissemination or reconciliation pending),
  the chaincode returns `PHI_UNAVAILABLE`, which maps to 503 rather than 404.

## Revocation

1. Registry: `DeactivateUser` / `SetProviderActive(false)` take effect at the next block.
   Every transaction reads the caller's registry entry, and a deactivation that commits first
   invalidates in-flight transactions through MVCC.
2. Certificate: `network/revoke-user.sh` revokes the enrollment at the CA, generates a CRL, and
   adds it to Org1MSP's `revocation_list` in a channel config update. Peers then reject the
   certificate at MSP validation, even if the registry entry is active again. The e2e checks
   both layers.

## Serverless tier and denial of service

The IEEE CCCI 2024 paper this repo tests frames cold-start amplification as a risk: attackers
send cheap requests that each force an expensive wake-up. Mitigations here:

- The activator verifies JWT signature, issuer, audience and expiry before waking. An
  unauthenticated request gets 401 and wakes nothing.
- Only `/auth/login` passes without a token. It has a per-IP token bucket, and it wakes only the
  API container, never the peers.
- There is a global cap on concurrent wakes and a bounded wait queue (503 beyond it). `/healthz`
  is answered by the activator itself.
- A wake that doesn't reach readiness within 90 s returns 503 with Retry-After. It never
  forwards a request to a half-ready endorsement path.

## Ransomware and data loss

The ledger and private data are replicated across both orgs' peers. SHA-256 digests on the
ledger make tampering with a peer's private store detectable (`VerifyRecordIntegrity`,
`ReadRecordPHI`). There is no backup or restore plan, and one host runs everything, so this demo
makes no availability claim.

## Out of scope

HIPAA administrative and physical safeguards, BAAs, risk analysis, multi-host deployment,
orderers run by different organizations (here one org runs all four), and encryption of
private data at rest. Fabric does not encrypt private data at rest.
