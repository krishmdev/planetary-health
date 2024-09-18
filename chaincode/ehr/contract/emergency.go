package contract

import (
	"encoding/json"
	"strings"
	"time"
)

const (
	breakGlassWindow = 60 * time.Minute
	minReasonLen     = 10
)

// RequestEmergencyAccess is break-glass: a doctor with no consent gets 60 minutes of access to
// one patient. The reason is mandatory, an event goes out, and the grant waits in the patient
// org's admin review queue.
func (c *EHRContract) RequestEmergencyAccess(ctx Ctx, pid, reason string) (*BreakGlass, error) {
	actor, err := requireRole(ctx, RoleDoctor)
	if err != nil {
		return nil, err
	}
	reason = strings.TrimSpace(reason)
	if len(reason) < minReasonLen {
		return nil, errInvalid("an emergency reason of at least %d characters is required", minReasonLen)
	}
	patient, err := getPatient(ctx, pid)
	if err != nil {
		return nil, err
	}
	if !patient.Active {
		return nil, errInvalid("patient %s is deactivated", pid)
	}
	now, err := freshTxTime(ctx)
	if err != nil {
		return nil, err
	}
	g := BreakGlass{GrantID: newID(ctx, "G-"), PatientID: pid, ProviderID: actor.ID, ProviderOrg: actor.Org,
		PatientOrg: patient.Org, Reason: reason, CreatedAt: stamp(now), ExpiresAt: stamp(now.Add(breakGlassWindow))}
	if err := putObj(ctx, g, objBreak, pid, g.GrantID); err != nil {
		return nil, err
	}
	if err := putObj(ctx, indexRef{PatientID: pid}, objBreakIdx, g.GrantID); err != nil {
		return nil, err
	}
	if err := putObj(ctx, indexRef{PatientID: pid}, objReviewQ, patient.Org, g.GrantID); err != nil {
		return nil, err
	}
	return &g, emit(ctx, "EmergencyAccess", g)
}

func (c *EHRContract) ListPendingEmergencyReviews(ctx Ctx) ([]BreakGlass, error) {
	admin, err := requireRole(ctx, RoleAdmin)
	if err != nil {
		return nil, err
	}
	it, err := ctx.GetStub().GetStateByPartialCompositeKey(objReviewQ, []string{admin.Org})
	if err != nil {
		return nil, err
	}
	defer it.Close()
	out := []BreakGlass{}
	for it.HasNext() {
		kv, err := it.Next()
		if err != nil {
			return nil, err
		}
		_, parts, err := ctx.GetStub().SplitCompositeKey(kv.Key)
		if err != nil || len(parts) != 2 {
			continue
		}
		var ref indexRef
		if err := json.Unmarshal(kv.Value, &ref); err != nil {
			return nil, err
		}
		g, err := getObj[BreakGlass](ctx, objBreak, ref.PatientID, parts[1])
		if err != nil {
			return nil, err
		}
		if g != nil && !g.Reviewed {
			out = append(out, *g)
		}
	}
	return out, nil
}

// ReviewEmergencyAccess closes a break-glass review. An "unjustified" outcome also ends the
// grant immediately if it is still inside its 60-minute window.
func (c *EHRContract) ReviewEmergencyAccess(ctx Ctx, grantID, outcome, note string) (*BreakGlass, error) {
	admin, err := requireRole(ctx, RoleAdmin)
	if err != nil {
		return nil, err
	}
	if outcome != "justified" && outcome != "unjustified" {
		return nil, errInvalid("outcome must be justified or unjustified")
	}
	ref, err := lookupIndex(ctx, objBreakIdx, grantID)
	if err != nil {
		return nil, err
	}
	if ref == nil {
		return nil, errNotFound("emergency grant %s", grantID)
	}
	g, err := getObj[BreakGlass](ctx, objBreak, ref.PatientID, grantID)
	if err != nil {
		return nil, err
	}
	if g == nil {
		return nil, errNotFound("emergency grant %s", grantID)
	}
	if g.PatientOrg != admin.Org {
		return nil, errDenied("only %s administrators review this grant", g.PatientOrg)
	}
	if g.Reviewed {
		return nil, errConflict("grant %s was already reviewed", grantID)
	}
	now, err := freshTxTime(ctx)
	if err != nil {
		return nil, err
	}
	g.Reviewed = true
	g.Outcome = outcome
	g.ReviewedBy = admin.ID
	g.ReviewNote = note
	if outcome == "unjustified" && before(now, g.ExpiresAt) {
		g.ExpiresAt = stamp(now)
	}
	if err := putObj(ctx, g, objBreak, g.PatientID, grantID); err != nil {
		return nil, err
	}
	qk, err := key(ctx, objReviewQ, g.PatientOrg, grantID)
	if err != nil {
		return nil, err
	}
	if err := ctx.GetStub().DelState(qk); err != nil {
		return nil, err
	}
	return g, emit(ctx, "EmergencyReviewed", g)
}
