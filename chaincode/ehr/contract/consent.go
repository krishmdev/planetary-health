package contract

import (
	"slices"
	"strings"
	"time"
)

const maxConsentDays = 365

// GrantConsent lets the calling patient give one provider scoped, expiring access. The grantee
// is data about whom to trust; the grantor is always the certificate holder.
func (c *EHRContract) GrantConsent(ctx Ctx, grantee string, types []string, actions []string,
	purpose, expiresAt string) (*Consent, error) {
	actor, err := requireRole(ctx, RolePatient)
	if err != nil {
		return nil, err
	}
	prov, err := getObj[Member](ctx, objProvider, grantee)
	if err != nil {
		return nil, err
	}
	if prov == nil {
		return nil, errNotFound("provider %s", grantee)
	}
	if !prov.Active {
		return nil, errInvalid("provider %s is deactivated", grantee)
	}
	if len(types) == 0 || len(actions) == 0 {
		return nil, errInvalid("consent needs at least one record type and one action")
	}
	for _, t := range types {
		if t != "*" && !recordTypes[t] {
			return nil, errInvalid("unknown record type %q", t)
		}
	}
	for _, a := range actions {
		if a != string(ActionRead) && a != string(ActionAppend) {
			return nil, errInvalid("unknown action %q", a)
		}
	}
	if strings.TrimSpace(purpose) == "" {
		return nil, errInvalid("purpose is required")
	}
	now, err := freshTxTime(ctx)
	if err != nil {
		return nil, err
	}
	exp, err := time.Parse(time.RFC3339Nano, expiresAt)
	if err != nil {
		return nil, errInvalid("expiresAt must be RFC3339")
	}
	if !exp.After(now) || exp.After(now.AddDate(0, 0, maxConsentDays)) {
		return nil, errInvalid("expiresAt must be in the future and within %d days", maxConsentDays)
	}
	types = dedupe(types)
	actions = dedupe(actions)
	cons := Consent{ConsentID: newID(ctx, "C-"), PatientID: actor.ID, Grantee: grantee, Types: types,
		Actions: actions, Purpose: purpose, Status: "active", CreatedAt: stamp(now), ExpiresAt: stamp(exp)}
	if err := putObj(ctx, cons, objConsent, actor.ID, grantee, cons.ConsentID); err != nil {
		return nil, err
	}
	if err := putObj(ctx, indexRef{PatientID: actor.ID, Grantee: grantee}, objConsentIx, cons.ConsentID); err != nil {
		return nil, err
	}
	if err := putObj(ctx, indexRef{PatientID: actor.ID}, objGrantee, grantee, actor.ID, cons.ConsentID); err != nil {
		return nil, err
	}
	return &cons, emit(ctx, "ConsentGranted", cons)
}

func loadConsent(ctx Ctx, consentID string) (*Consent, error) {
	ref, err := lookupIndex(ctx, objConsentIx, consentID)
	if err != nil {
		return nil, err
	}
	if ref == nil {
		return nil, errNotFound("consent %s", consentID)
	}
	cons, err := getObj[Consent](ctx, objConsent, ref.PatientID, ref.Grantee, consentID)
	if err != nil {
		return nil, err
	}
	if cons == nil {
		return nil, errNotFound("consent %s", consentID)
	}
	return cons, nil
}

// RevokeConsent ends a consent at the next block. Grants already issued from it are re-checked
// against the current consent when PHI is delivered, so they stop working too.
func (c *EHRContract) RevokeConsent(ctx Ctx, consentID string) (*Consent, error) {
	actor, err := requireRole(ctx, RolePatient)
	if err != nil {
		return nil, err
	}
	cons, err := loadConsent(ctx, consentID)
	if err != nil {
		return nil, err
	}
	if cons.PatientID != actor.ID {
		return nil, errDenied("only the granting patient can revoke consent %s", consentID)
	}
	if cons.Status == "revoked" {
		return nil, errConflict("consent %s is already revoked", consentID)
	}
	now, err := freshTxTime(ctx)
	if err != nil {
		return nil, err
	}
	cons.Status = "revoked"
	cons.RevokedAt = stamp(now)
	if err := putObj(ctx, cons, objConsent, cons.PatientID, cons.Grantee, consentID); err != nil {
		return nil, err
	}
	return cons, emit(ctx, "ConsentRevoked", cons)
}

// ListMyConsents returns what the caller granted (patient) or received (doctor).
func (c *EHRContract) ListMyConsents(ctx Ctx) ([]Consent, error) {
	actor, err := requireRole(ctx, RolePatient, RoleDoctor)
	if err != nil {
		return nil, err
	}
	if actor.Role == RolePatient {
		return listObj[Consent](ctx, objConsent, actor.ID)
	}
	refs, err := ctx.GetStub().GetStateByPartialCompositeKey(objGrantee, []string{actor.ID})
	if err != nil {
		return nil, err
	}
	defer refs.Close()
	out := []Consent{}
	for refs.HasNext() {
		kv, err := refs.Next()
		if err != nil {
			return nil, err
		}
		_, parts, err := ctx.GetStub().SplitCompositeKey(kv.Key)
		if err != nil || len(parts) != 3 {
			continue
		}
		cons, err := getObj[Consent](ctx, objConsent, parts[1], actor.ID, parts[2])
		if err != nil {
			return nil, err
		}
		if cons != nil {
			out = append(out, *cons)
		}
	}
	return out, nil
}

func (c *EHRContract) GetConsentHistory(ctx Ctx, consentID string) ([]HistoryEntry, error) {
	actor, err := currentActor(ctx)
	if err != nil {
		return nil, err
	}
	cons, err := loadConsent(ctx, consentID)
	if err != nil {
		return nil, err
	}
	switch {
	case actor.Role == RolePatient && actor.ID == cons.PatientID:
	case actor.Role == RoleDoctor && actor.ID == cons.Grantee:
	case actor.Role == RoleAdmin:
		patient, err := getPatient(ctx, cons.PatientID)
		if err != nil {
			return nil, err
		}
		if patient.Org != actor.Org {
			return nil, errDenied("consent %s belongs to another organization's patient", consentID)
		}
	default:
		return nil, errDenied("not a party to consent %s", consentID)
	}
	k, err := key(ctx, objConsent, cons.PatientID, cons.Grantee, consentID)
	if err != nil {
		return nil, err
	}
	return history(ctx, k)
}

func dedupe(in []string) []string {
	out := slices.Clone(in)
	slices.Sort(out)
	return slices.Compact(out)
}
