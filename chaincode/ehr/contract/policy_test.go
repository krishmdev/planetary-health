package contract

import (
	"testing"
	"time"
)

func TestAuthorize(t *testing.T) {
	now := time.Date(2024, 9, 1, 12, 0, 0, 0, time.UTC)
	later := stamp(now.Add(time.Hour))
	earlier := stamp(now.Add(-time.Minute))

	alice := Member{ID: "P-1001", Role: RolePatient, Org: "Org1MSP", Active: true}
	inactivePatient := alice
	inactivePatient.Active = false

	patient := Actor{ID: "P-1001", Role: RolePatient, Org: "Org1MSP", Active: true}
	otherPatient := Actor{ID: "P-1002", Role: RolePatient, Org: "Org1MSP", Active: true}
	chen := Actor{ID: "D-2001", Role: RoleDoctor, Org: "Org1MSP", Active: true}
	rivera := Actor{ID: "D-3001", Role: RoleDoctor, Org: "Org2MSP", Active: true}
	inactiveDoc := chen
	inactiveDoc.Active = false
	ada := Actor{ID: "A-1001", Role: RoleAdmin, Org: "Org1MSP", Active: true}
	omar := Actor{ID: "A-3001", Role: RoleAdmin, Org: "Org2MSP", Active: true}
	stranger := Actor{ID: "X-1", Role: "auditor", Org: "Org1MSP", Active: true}

	consent := func(grantee string, types []string, actions []string, exp, status string) Consent {
		return Consent{ConsentID: "C-1", PatientID: "P-1001", Grantee: grantee, Types: types, Actions: actions,
			ExpiresAt: exp, Status: status}
	}
	labRead := consent("D-2001", []string{"lab"}, []string{"read"}, later, "active")
	labAppend := consent("D-2001", []string{"lab"}, []string{"append"}, later, "active")
	allRead := consent("D-2001", []string{"*"}, []string{"read"}, later, "active")
	expired := consent("D-2001", []string{"lab"}, []string{"read"}, earlier, "active")
	revoked := consent("D-2001", []string{"lab"}, []string{"read"}, later, "revoked")
	riveraLab := consent("D-3001", []string{"lab"}, []string{"read"}, later, "active")
	badExpiry := consent("D-2001", []string{"lab"}, []string{"read"}, "tomorrow", "active")
	otherPatientsConsent := labRead
	otherPatientsConsent.PatientID = "P-1002"

	bg := BreakGlass{GrantID: "G-1", PatientID: "P-1001", ProviderID: "D-2001", ExpiresAt: later}
	bgExpired := bg
	bgExpired.ExpiresAt = earlier
	bgUnjustified := bg
	bgUnjustified.Reviewed, bgUnjustified.Outcome = true, "unjustified"
	bgJustified := bg
	bgJustified.Reviewed, bgJustified.Outcome = true, "justified"

	cases := []struct {
		name      string
		actor     Actor
		patient   Member
		typ       string
		action    Action
		consents  []Consent
		grants    []BreakGlass
		wantOK    bool
		wantBasis string
	}{
		{"patient reads own record", patient, alice, "lab", ActionRead, nil, nil, true, "self"},
		{"patient lists own records", patient, alice, "", ActionMeta, nil, nil, true, "self"},
		{"patient cannot read another patient", otherPatient, alice, "lab", ActionRead, nil, nil, false, ""},
		{"patient cannot append", patient, alice, "note", ActionAppend, nil, nil, false, ""},
		{"consent in scope", chen, alice, "lab", ActionRead, []Consent{labRead}, nil, true, "consent:C-1"},
		{"wildcard consent", chen, alice, "imaging", ActionRead, []Consent{allRead}, nil, true, "consent:C-1"},
		{"consent wrong record type", chen, alice, "imaging", ActionRead, []Consent{labRead}, nil, false, ""},
		{"consent wrong action", chen, alice, "lab", ActionRead, []Consent{labAppend}, nil, false, ""},
		{"append consent allows append", chen, alice, "lab", ActionAppend, []Consent{labAppend}, nil, true, "consent:C-1"},
		{"read consent does not allow append", chen, alice, "lab", ActionAppend, []Consent{labRead}, nil, false, ""},
		{"read consent allows metadata", chen, alice, "lab", ActionMeta, []Consent{labRead}, nil, true, "consent:C-1"},
		{"listing with any read consent", chen, alice, "", ActionMeta, []Consent{labRead}, nil, true, "consent:C-1"},
		{"expired consent", chen, alice, "lab", ActionRead, []Consent{expired}, nil, false, ""},
		{"unparseable expiry counts as expired", chen, alice, "lab", ActionRead, []Consent{badExpiry}, nil, false, ""},
		{"revoked consent", chen, alice, "lab", ActionRead, []Consent{revoked}, nil, false, ""},
		{"consent for another doctor", chen, alice, "lab", ActionRead, []Consent{riveraLab}, nil, false, ""},
		{"consent for another patient", chen, alice, "lab", ActionRead, []Consent{otherPatientsConsent}, nil, false, ""},
		{"cross-org doctor with consent", rivera, alice, "lab", ActionRead, []Consent{riveraLab}, nil, true, "consent:C-1"},
		{"cross-org doctor without consent", rivera, alice, "lab", ActionRead, nil, nil, false, ""},
		{"inactive provider", inactiveDoc, alice, "lab", ActionRead, []Consent{labRead}, nil, false, ""},
		{"deactivated patient blocks doctors", chen, inactivePatient, "lab", ActionRead, []Consent{labRead}, nil, false, ""},
		{"active break-glass", chen, alice, "imaging", ActionRead, nil, []BreakGlass{bg}, true, "breakglass:G-1"},
		{"break-glass allows append", chen, alice, "note", ActionAppend, nil, []BreakGlass{bg}, true, "breakglass:G-1"},
		{"expired break-glass", chen, alice, "lab", ActionRead, nil, []BreakGlass{bgExpired}, false, ""},
		{"break-glass reviewed unjustified", chen, alice, "lab", ActionRead, nil, []BreakGlass{bgUnjustified}, false, ""},
		{"break-glass reviewed justified", chen, alice, "lab", ActionRead, nil, []BreakGlass{bgJustified}, true, "breakglass:G-1"},
		{"break-glass for another doctor", rivera, alice, "lab", ActionRead, nil, []BreakGlass{bg}, false, ""},
		{"consent preferred over break-glass", chen, alice, "lab", ActionRead, []Consent{labRead}, []BreakGlass{bg}, true, "consent:C-1"},
		{"admin denied PHI", ada, alice, "lab", ActionRead, nil, nil, false, ""},
		{"admin denied append", ada, alice, "lab", ActionAppend, nil, nil, false, ""},
		{"admin sees own org metadata", ada, alice, "lab", ActionMeta, nil, nil, true, "admin:metadata"},
		{"admin denied other org metadata", omar, alice, "lab", ActionMeta, nil, nil, false, ""},
		{"unknown role", stranger, alice, "lab", ActionMeta, nil, nil, false, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := Authorize(tc.actor, tc.patient, tc.typ, tc.action, now, tc.consents, tc.grants)
			if d.Allowed != tc.wantOK {
				t.Fatalf("allowed = %v (reason %q), want %v", d.Allowed, d.Reason, tc.wantOK)
			}
			if d.Basis != tc.wantBasis {
				t.Fatalf("basis = %q, want %q", d.Basis, tc.wantBasis)
			}
			if !d.Allowed && d.Reason == "" {
				t.Fatal("a denial must carry a reason")
			}
		})
	}
}

func TestConsentExpiryBoundary(t *testing.T) {
	now := time.Date(2024, 9, 1, 12, 0, 0, 0, time.UTC)
	c := Consent{ConsentID: "C-1", PatientID: "P-1", Grantee: "D-1", Types: []string{"lab"},
		Actions: []string{"read"}, Status: "active", ExpiresAt: stamp(now)}
	doc := Actor{ID: "D-1", Role: RoleDoctor, Active: true}
	p := Member{ID: "P-1", Active: true}
	if Authorize(doc, p, "lab", ActionRead, now, []Consent{c}, nil).Allowed {
		t.Fatal("a consent must be expired at exactly its expiry instant")
	}
	if !Authorize(doc, p, "lab", ActionRead, now.Add(-time.Nanosecond), []Consent{c}, nil).Allowed {
		t.Fatal("a consent must be valid just before expiry")
	}
}
