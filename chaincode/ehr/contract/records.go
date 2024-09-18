package contract

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
)

const transientPHI = "phi"

// authorize loads the policy inputs for (actor, patient) from the ledger and runs Authorize.
// Doctors' consent and break-glass keys are read by range query, so a consent revocation or new
// break-glass grant that commits first makes this transaction fail validation.
func authorize(ctx Ctx, actor *Actor, patient *Member, recordType string, action Action) (Decision, error) {
	now, err := txTime(ctx)
	if err != nil {
		return Decision{}, err
	}
	var consents []Consent
	var grants []BreakGlass
	if actor.Role == RoleDoctor {
		if consents, err = listObj[Consent](ctx, objConsent, patient.ID, actor.ID); err != nil {
			return Decision{}, err
		}
		all, err := listObj[BreakGlass](ctx, objBreak, patient.ID)
		if err != nil {
			return Decision{}, err
		}
		for _, g := range all {
			if g.ProviderID == actor.ID {
				grants = append(grants, g)
			}
		}
	}
	return Authorize(*actor, *patient, recordType, action, now, consents, grants), nil
}

func mustAuthorize(ctx Ctx, actor *Actor, patient *Member, recordType string, action Action) (Decision, error) {
	d, err := authorize(ctx, actor, patient, recordType, action)
	if err != nil {
		return d, err
	}
	if !d.Allowed {
		return d, errDenied("%s", d.Reason)
	}
	return d, nil
}

func loadRecord(ctx Ctx, rid string) (*RecordMeta, error) {
	ref, err := lookupIndex(ctx, objRecordIdx, rid)
	if err != nil {
		return nil, err
	}
	if ref == nil {
		return nil, errNotFound("record %s", rid)
	}
	m, err := getObj[RecordMeta](ctx, objRecord, ref.PatientID, rid)
	if err != nil {
		return nil, err
	}
	if m == nil {
		return nil, errNotFound("record %s", rid)
	}
	return m, nil
}

// CreateRecord stores PHI from the transient map in the private collection and its SHA-256 in
// public state. The PHI itself never appears in the proposal args or the block.
func (c *EHRContract) CreateRecord(ctx Ctx, pid, recordType string) (*RecordMeta, error) {
	actor, err := requireRole(ctx, RoleDoctor)
	if err != nil {
		return nil, err
	}
	if !recordTypes[recordType] {
		return nil, errInvalid("unknown record type %q", recordType)
	}
	patient, err := getPatient(ctx, pid)
	if err != nil {
		return nil, err
	}
	if _, err := mustAuthorize(ctx, actor, patient, recordType, ActionAppend); err != nil {
		return nil, err
	}
	tm, err := ctx.GetStub().GetTransient()
	if err != nil {
		return nil, err
	}
	phi := tm[transientPHI]
	if len(phi) == 0 {
		return nil, errInvalid("PHI must be passed in the transient map under %q", transientPHI)
	}
	if len(phi) > 64*1024 {
		return nil, errInvalid("PHI payload over 64 KiB")
	}
	now, err := txTime(ctx)
	if err != nil {
		return nil, err
	}
	rid := newID(ctx, "R-")
	sum := sha256.Sum256(phi)
	meta := RecordMeta{RecordID: rid, PatientID: pid, Type: recordType, CreatedBy: actor.ID, Org: actor.Org,
		CreatedAt: stamp(now), PHISha256: hex.EncodeToString(sum[:]), Version: 1}
	if err := ctx.GetStub().PutPrivateData(phiCollection, rid, phi); err != nil {
		return nil, err
	}
	if err := putObj(ctx, meta, objRecord, pid, rid); err != nil {
		return nil, err
	}
	if err := putObj(ctx, indexRef{PatientID: pid}, objRecordIdx, rid); err != nil {
		return nil, err
	}
	return &meta, emit(ctx, "RecordCreated", meta)
}

func (c *EHRContract) ListPatientRecords(ctx Ctx, pid string) ([]RecordMeta, error) {
	actor, err := currentActor(ctx)
	if err != nil {
		return nil, err
	}
	patient, err := getPatient(ctx, pid)
	if err != nil {
		return nil, err
	}
	if _, err := mustAuthorize(ctx, actor, patient, "", ActionMeta); err != nil {
		return nil, err
	}
	all, err := listObj[RecordMeta](ctx, objRecord, pid)
	if err != nil {
		return nil, err
	}
	out := []RecordMeta{}
	for _, m := range all {
		d, err := authorize(ctx, actor, patient, m.Type, ActionMeta)
		if err != nil {
			return nil, err
		}
		if d.Allowed {
			out = append(out, m)
		}
	}
	return out, nil
}

func (c *EHRContract) GetRecordMeta(ctx Ctx, rid string) (*RecordMeta, error) {
	m, _, err := c.metaFor(ctx, rid)
	return m, err
}

func (c *EHRContract) metaFor(ctx Ctx, rid string) (*RecordMeta, *Actor, error) {
	actor, err := currentActor(ctx)
	if err != nil {
		return nil, nil, err
	}
	m, err := loadRecord(ctx, rid)
	if err != nil {
		return nil, nil, err
	}
	patient, err := getPatient(ctx, m.PatientID)
	if err != nil {
		return nil, nil, err
	}
	if _, err := mustAuthorize(ctx, actor, patient, m.Type, ActionMeta); err != nil {
		return nil, nil, err
	}
	return m, actor, nil
}

// GetRecordHistory uses GetHistoryForKey, which Fabric only supports reliably in evaluations.
func (c *EHRContract) GetRecordHistory(ctx Ctx, rid string) ([]HistoryEntry, error) {
	m, _, err := c.metaFor(ctx, rid)
	if err != nil {
		return nil, err
	}
	k, err := key(ctx, objRecord, m.PatientID, rid)
	if err != nil {
		return nil, err
	}
	return history(ctx, k)
}

func history(ctx Ctx, k string) ([]HistoryEntry, error) {
	it, err := ctx.GetStub().GetHistoryForKey(k)
	if err != nil {
		return nil, err
	}
	defer it.Close()
	out := []HistoryEntry{}
	for it.HasNext() {
		km, err := it.Next()
		if err != nil {
			return nil, err
		}
		e := HistoryEntry{TxID: km.TxId, IsDelete: km.IsDelete, Value: string(km.Value)}
		if km.Timestamp != nil {
			e.Timestamp = stamp(km.Timestamp.AsTime())
		}
		out = append(out, e)
	}
	return out, nil
}

// VerifyRecordIntegrity compares a caller-supplied digest with both the on-ledger digest and
// the private-data hash that every collection member peer holds.
func (c *EHRContract) VerifyRecordIntegrity(ctx Ctx, rid, sha string) (*IntegrityReport, error) {
	m, _, err := c.metaFor(ctx, rid)
	if err != nil {
		return nil, err
	}
	r := &IntegrityReport{RecordID: rid, OnLedger: m.PHISha256, Supplied: strings.ToLower(sha)}
	if m.Purged {
		r.Reason = "PHI was purged; only the digest remains"
		return r, nil
	}
	h, err := ctx.GetStub().GetPrivateDataHash(phiCollection, rid)
	if err != nil {
		return nil, err
	}
	r.PrivateHash = hex.EncodeToString(h)
	phi, err := ctx.GetStub().GetPrivateData(phiCollection, rid)
	if err != nil {
		return nil, err
	}
	if phi != nil {
		sum := sha256.Sum256(phi)
		r.DataHash = hex.EncodeToString(sum[:])
	}
	r.Match = r.PrivateHash == m.PHISha256 && r.Supplied == m.PHISha256 && (phi == nil || r.DataHash == m.PHISha256)
	switch {
	case phi != nil && r.DataHash != m.PHISha256:
		r.Reason = "stored private data does not hash to the ledger digest"
	case r.PrivateHash != m.PHISha256:
		r.Reason = "private data hash does not match the ledger digest"
	case r.Supplied != m.PHISha256:
		r.Reason = "supplied digest does not match the ledger digest"
	case phi == nil:
		r.Reason = "this peer holds no copy of the private data; checked the hash only"
	}
	return r, nil
}

// RequestRecordPurge is the patient's side of a purge: it flags the record for an admin.
func (c *EHRContract) RequestRecordPurge(ctx Ctx, rid string) (*RecordMeta, error) {
	actor, err := requireRole(ctx, RolePatient)
	if err != nil {
		return nil, err
	}
	m, err := loadRecord(ctx, rid)
	if err != nil {
		return nil, err
	}
	if m.PatientID != actor.ID {
		return nil, errDenied("patients can only request purges of their own records")
	}
	if m.Purged {
		return nil, errConflict("record %s is already purged", rid)
	}
	m.PurgeRequested = true
	if err := putObj(ctx, m, objRecord, m.PatientID, rid); err != nil {
		return nil, err
	}
	return m, emit(ctx, "PurgeRequested", m)
}

// PurgeRecordPHI removes the PHI from every peer's private store (and its history) with
// PurgePrivateData. The public digest stays so the record's existence is still auditable.
func (c *EHRContract) PurgeRecordPHI(ctx Ctx, rid string) (*RecordMeta, error) {
	admin, err := requireRole(ctx, RoleAdmin)
	if err != nil {
		return nil, err
	}
	m, err := loadRecord(ctx, rid)
	if err != nil {
		return nil, err
	}
	patient, err := getPatient(ctx, m.PatientID)
	if err != nil {
		return nil, err
	}
	if patient.Org != admin.Org {
		return nil, errDenied("only %s administrators can purge this record", patient.Org)
	}
	if !m.PurgeRequested {
		return nil, errInvalid("the patient has not requested a purge of %s", rid)
	}
	if m.Purged {
		return nil, errConflict("record %s is already purged", rid)
	}
	if err := ctx.GetStub().PurgePrivateData(phiCollection, rid); err != nil {
		return nil, err
	}
	now, err := txTime(ctx)
	if err != nil {
		return nil, err
	}
	m.Purged = true
	m.PurgedAt = stamp(now)
	m.Version++
	if err := putObj(ctx, m, objRecord, m.PatientID, rid); err != nil {
		return nil, err
	}
	return m, emit(ctx, "RecordPurged", m)
}

func mustJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
