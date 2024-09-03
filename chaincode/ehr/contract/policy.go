package contract

import (
	"slices"
	"time"
)

type Action string

const (
	ActionRead   Action = "read"   // PHI contents
	ActionAppend Action = "append" // add a clinical record
	ActionMeta   Action = "meta"   // public metadata (type, author, hash)
)

// Actor is the caller as derived from the transaction's client identity plus its registry entry.
type Actor struct {
	ID           string
	Role         string
	Org          string
	EnrollmentID string
	CertID       string
	Active       bool
}

type Decision struct {
	Allowed bool
	Basis   string
	Reason  string
}

func allow(basis string) Decision { return Decision{Allowed: true, Basis: basis} }
func deny(reason string) Decision { return Decision{Reason: reason} }

// Authorize is the whole access policy. It is pure so every rule can be table-tested; callers
// load the consents and break-glass grants for (patient, actor) and pass them in. recordType ""
// means "any record of this patient" and is used for listing metadata.
func Authorize(actor Actor, patient Member, recordType string, action Action, now time.Time,
	consents []Consent, grants []BreakGlass) Decision {
	if !actor.Active {
		return deny("caller is deactivated")
	}
	switch actor.Role {
	case RolePatient:
		if actor.ID != patient.ID {
			return deny("patients can only access their own records")
		}
		if action == ActionAppend {
			return deny("patients cannot add clinical records")
		}
		return allow("self")
	case RoleAdmin:
		if action != ActionMeta {
			return deny("administrators cannot read or write PHI (minimum necessary)")
		}
		if patient.Org != actor.Org {
			return deny("administrators only see their own organization's patients")
		}
		return allow("admin:metadata")
	case RoleDoctor:
		if !patient.Active {
			return deny("patient is deactivated")
		}
		for _, c := range consents {
			if consentCovers(c, actor.ID, patient.ID, recordType, action, now) {
				return allow("consent:" + c.ConsentID)
			}
		}
		for _, g := range grants {
			if breakGlassActive(g, actor.ID, patient.ID, now) {
				return allow("breakglass:" + g.GrantID)
			}
		}
		return deny("no active consent or emergency access for this record")
	default:
		return deny("unknown role")
	}
}

func consentCovers(c Consent, grantee, pid, recordType string, action Action, now time.Time) bool {
	if c.Grantee != grantee || c.PatientID != pid || c.Status != "active" {
		return false
	}
	if !before(now, c.ExpiresAt) {
		return false
	}
	need := string(action)
	if action == ActionMeta {
		need = string(ActionRead)
	}
	if !slices.Contains(c.Actions, need) {
		return false
	}
	if recordType == "" || slices.Contains(c.Types, "*") {
		return true
	}
	return slices.Contains(c.Types, recordType)
}

func breakGlassActive(g BreakGlass, provider, pid string, now time.Time) bool {
	if g.ProviderID != provider || g.PatientID != pid {
		return false
	}
	if g.Reviewed && g.Outcome == "unjustified" {
		return false
	}
	return before(now, g.ExpiresAt)
}

// before reports whether now is strictly before the RFC3339 timestamp ts. Unparseable
// timestamps count as already expired.
func before(now time.Time, ts string) bool {
	t, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		return false
	}
	return now.Before(t)
}
