package contract

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"
	"time"
)

// Reading PHI is split in two because a submit's response payload is written into the block:
//
//  1. RequestAccess (submit, MAJORITY-endorsed) runs the policy and records an AccessGrant.
//  2. ReadRecordPHI (evaluate) re-checks the policy against current state and returns PHI.
//
// Single use of a grant is enforced by the org gateway, which then submits RecordDelivery as a
// receipt. See docs/threat-model.md for what the ledger does and does not guarantee.

const grantTTL = 5 * time.Minute

func (c *EHRContract) RequestAccess(ctx Ctx, rid, purpose string) (*AccessGrant, error) {
	actor, err := currentActor(ctx)
	if err != nil {
		return nil, err
	}
	purpose = strings.TrimSpace(purpose)
	if purpose == "" {
		return nil, errInvalid("purpose is required")
	}
	m, err := loadRecord(ctx, rid)
	if err != nil {
		return nil, err
	}
	if m.Purged {
		return nil, errNotFound("record %s was purged", rid)
	}
	patient, err := getPatient(ctx, m.PatientID)
	if err != nil {
		return nil, err
	}
	d, err := mustAuthorize(ctx, actor, patient, m.Type, ActionRead)
	if err != nil {
		return nil, err
	}
	now, err := txTime(ctx)
	if err != nil {
		return nil, err
	}
	nonce := sha256.Sum256([]byte("nonce:" + ctx.GetStub().GetTxID()))
	g := AccessGrant{AccessID: newID(ctx, "A-"), PatientID: m.PatientID, RecordID: rid, RecordType: m.Type,
		Actor: actor.ID, ActorCertID: actor.CertID, ActorOrg: actor.Org, Role: actor.Role, Purpose: purpose,
		Basis: d.Basis, Nonce: hex.EncodeToString(nonce[:8]), Status: GrantGranted,
		CreatedAt: stamp(now), ExpiresAt: stamp(now.Add(grantTTL))}
	if err := putObj(ctx, g, objAccess, g.PatientID, g.AccessID); err != nil {
		return nil, err
	}
	if err := putObj(ctx, indexRef{PatientID: g.PatientID}, objAccessIdx, g.AccessID); err != nil {
		return nil, err
	}
	return &g, emit(ctx, "AccessGranted", g)
}

func loadGrant(ctx Ctx, accessID string) (*AccessGrant, error) {
	ref, err := lookupIndex(ctx, objAccessIdx, accessID)
	if err != nil {
		return nil, err
	}
	if ref == nil {
		return nil, errNotFound("access grant %s", accessID)
	}
	g, err := getObj[AccessGrant](ctx, objAccess, ref.PatientID, accessID)
	if err != nil {
		return nil, err
	}
	if g == nil {
		return nil, errNotFound("access grant %s", accessID)
	}
	return g, nil
}

// ReadRecordPHI must only be evaluated. It checks that the caller is the grant's holder, the
// grant is unexpired and unused on-ledger, the policy still allows the read with the peer's
// current consents (so a revocation after the grant is honored), and that the private data
// matches the on-ledger digest.
func (c *EHRContract) ReadRecordPHI(ctx Ctx, accessID string) (*PHIResponse, error) {
	actor, err := currentActor(ctx)
	if err != nil {
		return nil, err
	}
	g, err := loadGrant(ctx, accessID)
	if err != nil {
		return nil, err
	}
	if g.ActorCertID != actor.CertID || g.Actor != actor.ID {
		return nil, errDenied("access grant %s was issued to another user", accessID)
	}
	switch g.Status {
	case GrantRevoked:
		return nil, errDenied("access grant %s was revoked", accessID)
	case GrantDelivered:
		return nil, errDenied("access grant %s was already used", accessID)
	}
	now, err := txTime(ctx)
	if err != nil {
		return nil, err
	}
	if !before(now, g.ExpiresAt) {
		return nil, errDenied("access grant %s expired at %s", accessID, g.ExpiresAt)
	}
	m, err := loadRecord(ctx, g.RecordID)
	if err != nil {
		return nil, err
	}
	if m.Purged {
		return nil, errNotFound("record %s was purged", m.RecordID)
	}
	patient, err := getPatient(ctx, m.PatientID)
	if err != nil {
		return nil, err
	}
	d, err := mustAuthorize(ctx, actor, patient, m.Type, ActionRead)
	if err != nil {
		return nil, err
	}
	h, err := ctx.GetStub().GetPrivateDataHash(phiCollection, m.RecordID)
	if err != nil {
		return nil, err
	}
	if hex.EncodeToString(h) != m.PHISha256 {
		return nil, errIntegrity("private data for %s does not match its ledger digest", m.RecordID)
	}
	phi, err := ctx.GetStub().GetPrivateData(phiCollection, m.RecordID)
	if err != nil {
		return nil, err
	}
	if phi == nil {
		return nil, errNotFound("this peer holds no private data for %s yet", m.RecordID)
	}
	return &PHIResponse{AccessID: accessID, RecordID: m.RecordID, PatientID: m.PatientID, Type: m.Type,
		PHI: string(phi), PHISha256: m.PHISha256, Basis: d.Basis}, nil
}

// RecordDelivery is the gateway's receipt that it released PHI for a grant. Late receipts are
// accepted (the gateway retries from an outbox), so expiry is not checked here.
func (c *EHRContract) RecordDelivery(ctx Ctx, accessID string) (*AccessGrant, error) {
	actor, err := currentActor(ctx)
	if err != nil {
		return nil, err
	}
	g, err := loadGrant(ctx, accessID)
	if err != nil {
		return nil, err
	}
	if g.ActorCertID != actor.CertID {
		return nil, errDenied("access grant %s was issued to another user", accessID)
	}
	if g.Status == GrantDelivered {
		return nil, errConflict("delivery for %s already recorded", accessID)
	}
	now, err := txTime(ctx)
	if err != nil {
		return nil, err
	}
	g.Status = GrantDelivered
	g.DeliveredAt = stamp(now)
	g.DeliveryTx = ctx.GetStub().GetTxID()
	if err := putObj(ctx, g, objAccess, g.PatientID, accessID); err != nil {
		return nil, err
	}
	return g, emit(ctx, "DeliveryRecorded", g)
}

// RevokeAccessGrants cancels the calling patient's outstanding (unused, unexpired) grants.
func (c *EHRContract) RevokeAccessGrants(ctx Ctx) ([]AccessGrant, error) {
	actor, err := requireRole(ctx, RolePatient)
	if err != nil {
		return nil, err
	}
	now, err := txTime(ctx)
	if err != nil {
		return nil, err
	}
	all, err := listObj[AccessGrant](ctx, objAccess, actor.ID)
	if err != nil {
		return nil, err
	}
	revoked := []AccessGrant{}
	for _, g := range all {
		if g.Status != GrantGranted || !before(now, g.ExpiresAt) {
			continue
		}
		g.Status = GrantRevoked
		if err := putObj(ctx, g, objAccess, g.PatientID, g.AccessID); err != nil {
			return nil, err
		}
		revoked = append(revoked, g)
	}
	return revoked, emit(ctx, "AccessGrantsRevoked", map[string]any{"patientId": actor.ID, "count": len(revoked)})
}

func (c *EHRContract) authorizeAudit(ctx Ctx, pid string) error {
	actor, err := currentActor(ctx)
	if err != nil {
		return err
	}
	switch actor.Role {
	case RolePatient:
		if actor.ID != pid {
			return errDenied("patients can only see their own access log")
		}
		return nil
	case RoleAdmin:
		patient, err := getPatient(ctx, pid)
		if err != nil {
			return err
		}
		if patient.Org != actor.Org {
			return errDenied("administrators only see their own organization's patients")
		}
		return nil
	}
	return errDenied("role %s cannot read access logs", actor.Role)
}

type AccessLog struct {
	PatientID string        `json:"patientId"`
	Grants    []AccessGrant `json:"grants"`
	Emergency []BreakGlass  `json:"emergency"`
}

// GetAccessLog is the patient's view of who asked for their records, why, and on what basis.
func (c *EHRContract) GetAccessLog(ctx Ctx, pid string) (*AccessLog, error) {
	if err := c.authorizeAudit(ctx, pid); err != nil {
		return nil, err
	}
	grants, err := listObj[AccessGrant](ctx, objAccess, pid)
	if err != nil {
		return nil, err
	}
	bgs, err := listObj[BreakGlass](ctx, objBreak, pid)
	if err != nil {
		return nil, err
	}
	sort.Slice(grants, func(i, j int) bool { return grants[i].CreatedAt > grants[j].CreatedAt })
	sort.Slice(bgs, func(i, j int) bool { return bgs[i].CreatedAt > bgs[j].CreatedAt })
	return &AccessLog{PatientID: pid, Grants: grants, Emergency: bgs}, nil
}

// AuditReconcile classifies a patient's grants by delivery state. The gateway joins this with
// its local delivery log to flag PHI releases that never got an on-ledger receipt.
func (c *EHRContract) AuditReconcile(ctx Ctx, pid string) (*ReconcileReport, error) {
	if err := c.authorizeAudit(ctx, pid); err != nil {
		return nil, err
	}
	now, err := txTime(ctx)
	if err != nil {
		return nil, err
	}
	grants, err := listObj[AccessGrant](ctx, objAccess, pid)
	if err != nil {
		return nil, err
	}
	r := &ReconcileReport{PatientID: pid, Grants: grants}
	for _, g := range grants {
		switch {
		case g.Status == GrantDelivered:
			r.Delivered++
		case g.Status == GrantRevoked:
			r.Revoked++
		case before(now, g.ExpiresAt):
			r.Pending++
		default:
			r.ExpiredUnused++
		}
	}
	return r, nil
}
