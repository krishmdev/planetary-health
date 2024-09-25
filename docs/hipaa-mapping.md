# HIPAA §164.312 mapping

How the technical safeguards in the HIPAA Security Rule map onto this code, and where the mapping
is weak. This is not a compliance claim. The project is not HIPAA compliant or certified. It
uses synthetic data only, runs on one machine, and leaves out everything administrative and
physical: BAAs, risk analysis, workforce training, facility controls, backups, and incident
response.

| Safeguard | Citation | Implementation | Caveat |
|---|---|---|---|
| Unique user identification | §164.312(a)(2)(i) | One X.509 certificate per user with `ehr.id`; chaincode derives the caller only from `cid` (`contract/identity.go`) | Keys are custodial in the gateway wallet |
| Emergency access procedure | §164.312(a)(2)(ii) | Break-glass: reason required, 60-minute expiry, chaincode event, review queue in the patient's org, "unjustified" ends access (`contract/emergency.go`) | Review is by an admin of the same system |
| Automatic logoff | §164.312(a)(2)(iii) | 15-minute JWT; the UI signs out after 10 minutes without input | Token revocation before expiry isn't implemented; registry deactivation still blocks the next transaction |
| Encryption and decryption | §164.312(a)(2)(iv) | TLS on every Fabric link; wallet keys encrypted with AES-256-GCM | Private data at rest is not encrypted by Fabric; the dev REST API is plain HTTP |
| Audit controls | §164.312(b) | Every PHI read needs an on-ledger, MAJORITY-endorsed `AccessGrant`; delivery receipts; `GetHistoryForKey` on records and consents; `AuditReconcile` flags deliveries without a receipt | Delivery counts are trusted to each org's gateway; a peer admin reading their own database directly is not logged |
| Integrity | §164.312(c)(1)–(2) | SHA-256 of each record on the ledger; the bytes released are re-hashed and compared, plus the peer's private-data hash; `VerifyRecordIntegrity` | Detects tampering, doesn't prevent a peer operator from deleting their own copy |
| Person or entity authentication | §164.312(d) | Password (scrypt) → JWT → per-user certificate; MSP signature validation; CRL revocation (`network/revoke-user.sh`) | Single factor |
| Transmission security | §164.312(e)(1) | TLS for peer, orderer and CA traffic | Browser ↔ gateway is HTTP in the local demo |
| Minimum necessary / access management | §164.502(b), §164.308(a)(4) | Consent scoped by record type and action with expiry; admins see metadata only; doctors see only record types their consent covers | |
| Information system activity review | §164.308(a)(1)(ii)(D) | Break-glass review queue; patient-facing access log | |
| Right of access | §164.524 | Patients read their own records and their access log | No export format |
