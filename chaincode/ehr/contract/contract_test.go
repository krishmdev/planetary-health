package contract_test

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/krishmdev/planetary-health/chaincode/ehr/contract"
	"github.com/krishmdev/planetary-health/chaincode/ehr/internal/fakes"
)

type world struct {
	t    *testing.T
	stub *fakes.Stub
	cc   *contract.EHRContract
	now  time.Time
	ids  map[string]*fakes.Identity
}

func newWorld(t *testing.T) *world {
	t.Helper()
	start := time.Date(2024, 9, 1, 9, 0, 0, 0, time.UTC)
	w := &world{t: t, stub: fakes.NewStub(start), cc: &contract.EHRContract{}, now: start, ids: map[string]*fakes.Identity{
		"ada":    fakes.NewIdentity("Org1MSP", "ada", "admin", "A-1001"),
		"alice":  fakes.NewIdentity("Org1MSP", "alice", "patient", "P-1001"),
		"ben":    fakes.NewIdentity("Org1MSP", "ben", "patient", "P-1002"),
		"chen":   fakes.NewIdentity("Org1MSP", "drchen", "doctor", "D-2001"),
		"omar":   fakes.NewIdentity("Org2MSP", "omar", "admin", "A-3001"),
		"rivera": fakes.NewIdentity("Org2MSP", "drrivera", "doctor", "D-3001"),
		// Ping needs no registry entry or attributes.
		"probe": fakes.NewIdentity("Org1MSP", "probe", "", ""),
	}}
	// The peer's wall clock follows the simulated transaction time.
	contract.WallClock = func() time.Time { return w.now }
	t.Cleanup(func() { contract.WallClock = time.Now })
	_, err := w.cc.BootstrapAdmin(w.as("ada"))
	require.NoError(t, err)
	_, err = w.cc.RegisterPatient(w.as("ada"), "P-1001", "alice")
	require.NoError(t, err)
	_, err = w.cc.RegisterPatient(w.as("ada"), "P-1002", "ben")
	require.NoError(t, err)
	_, err = w.cc.RegisterProvider(w.as("ada"), "D-2001", "drchen", "cardiology")
	require.NoError(t, err)
	_, err = w.cc.BootstrapAdmin(w.as("omar"))
	require.NoError(t, err)
	_, err = w.cc.RegisterProvider(w.as("omar"), "D-3001", "drrivera", "emergency medicine")
	require.NoError(t, err)
	return w
}

// as starts a new transaction one second after the last one, signed by the named identity.
func (w *world) as(name string) *fakes.Context {
	return w.asWith(name, nil)
}

func (w *world) asWith(name string, transient map[string][]byte) *fakes.Context {
	w.now = w.now.Add(time.Second)
	w.stub.BeginTx(w.now, transient)
	id, ok := w.ids[name]
	if !ok {
		w.t.Fatalf("unknown identity %s", name)
	}
	return &fakes.Context{Stub: w.stub, Identity: id}
}

func (w *world) advance(d time.Duration) { w.now = w.now.Add(d) }

func (w *world) until(d time.Duration) string { return w.now.Add(d).UTC().Format(time.RFC3339) }

func (w *world) grantConsent(patient, grantee string, types, actions []string) *contract.Consent {
	w.t.Helper()
	c, err := w.cc.GrantConsent(w.as(patient), grantee, types, actions, "treatment", w.until(24*time.Hour))
	require.NoError(w.t, err)
	return c
}

func (w *world) createRecord(doctor, pid, typ, phi string) *contract.RecordMeta {
	w.t.Helper()
	m, err := w.cc.CreateRecord(w.asWith(doctor, map[string][]byte{"phi": seal(phi)}), pid, typ)
	require.NoError(w.t, err)
	return m
}

// seal wraps PHI the way the gateway does before it goes into the transient map.
func seal(phi string) []byte {
	data, _ := json.Marshal(phi)
	return []byte(`{"salt":"` + base64.StdEncoding.EncodeToString(make([]byte, 32)) + `","data":` + string(data) + `}`)
}

func requireCode(t *testing.T, err error, code string) {
	t.Helper()
	require.Error(t, err)
	require.True(t, strings.HasPrefix(err.Error(), code+":"), "want %s, got %v", code, err)
}

// seeded gives Chen lab read+append consent from Alice and creates one lab record.
func seeded(t *testing.T) (*world, *contract.RecordMeta) {
	w := newWorld(t)
	w.grantConsent("alice", "D-2001", []string{"lab"}, []string{"read", "append"})
	rec := w.createRecord("chen", "P-1001", "lab", `{"test":"HbA1c","value":"6.1%"}`)
	return w, rec
}

func TestCreateRecordKeepsPHIOffLedger(t *testing.T) {
	w, rec := seeded(t)
	sealed := w.stub.Private["PHICollection"][rec.RecordID]
	sum := sha256.Sum256(sealed)
	require.Equal(t, hex.EncodeToString(sum[:]), rec.PHISha256)
	require.Equal(t, "R-"+w.stub.GetTxID()[:16], rec.RecordID, "IDs derive from the tx ID")
	for k, v := range w.stub.State {
		require.NotContains(t, string(v), "HbA1c", "public key %q holds PHI", k)
	}
	require.Contains(t, string(sealed), "HbA1c")
	require.Equal(t, "RecordCreated", w.stub.LastEvent().Name)
}

func TestCreateRecordValidation(t *testing.T) {
	w := newWorld(t)
	w.grantConsent("alice", "D-2001", []string{"lab"}, []string{"append"})
	_, err := w.cc.CreateRecord(w.as("chen"), "P-1001", "lab")
	requireCode(t, err, "INVALID")
	_, err = w.cc.CreateRecord(w.asWith("chen", map[string][]byte{"phi": seal("x")}), "P-1001", "dna")
	requireCode(t, err, "INVALID")
	_, err = w.cc.CreateRecord(w.asWith("chen", map[string][]byte{"phi": seal("x")}), "P-1001", "imaging")
	requireCode(t, err, "ACCESS_DENIED")
	_, err = w.cc.CreateRecord(w.asWith("chen", map[string][]byte{"phi": seal("x")}), "P-9999", "lab")
	requireCode(t, err, "NOT_FOUND")
	big := make([]byte, 65*1024)
	_, err = w.cc.CreateRecord(w.asWith("chen", map[string][]byte{"phi": big}), "P-1001", "lab")
	requireCode(t, err, "INVALID")
}

func TestGrantThenDeliver(t *testing.T) {
	w, rec := seeded(t)
	g, err := w.cc.RequestAccess(w.as("chen"), rec.RecordID, "follow-up")
	require.NoError(t, err)
	require.Equal(t, "granted", g.Status)
	require.True(t, strings.HasPrefix(g.Basis, "consent:"))
	require.Equal(t, "AccessGranted", w.stub.LastEvent().Name)
	require.NotEmpty(t, g.Nonce)

	phi, err := w.cc.ReadRecordPHI(w.as("chen"), g.AccessID)
	require.NoError(t, err)
	require.Contains(t, phi.PHI, "HbA1c")
	require.Equal(t, rec.PHISha256, phi.PHISha256)

	d, err := w.cc.RecordDelivery(w.as("chen"), g.AccessID)
	require.NoError(t, err)
	require.Equal(t, "delivered", d.Status)
	_, err = w.cc.RecordDelivery(w.as("chen"), g.AccessID)
	requireCode(t, err, "CONFLICT")

	// Once the receipt is on the ledger, the grant can't be used again even through another
	// gateway that never saw the first delivery.
	_, err = w.cc.ReadRecordPHI(w.as("chen"), g.AccessID)
	requireCode(t, err, "ACCESS_DENIED")
}

func TestPatientReadsOwnRecord(t *testing.T) {
	w, rec := seeded(t)
	g, err := w.cc.RequestAccess(w.as("alice"), rec.RecordID, "personal copy")
	require.NoError(t, err)
	require.Equal(t, "self", g.Basis)
	_, err = w.cc.ReadRecordPHI(w.as("alice"), g.AccessID)
	require.NoError(t, err)
}

func TestSubjectSubstitution(t *testing.T) {
	w := newWorld(t)
	w.grantConsent("ben", "D-2001", []string{"*"}, []string{"read", "append"})
	benRec := w.createRecord("chen", "P-1002", "note", "ben's note")

	// Alice's certificate asking for Ben's data: the patient ID is only data, the caller is
	// always the certificate holder.
	_, err := w.cc.ListPatientRecords(w.as("alice"), "P-1002")
	requireCode(t, err, "ACCESS_DENIED")
	_, err = w.cc.RequestAccess(w.as("alice"), benRec.RecordID, "curious")
	requireCode(t, err, "ACCESS_DENIED")
	_, err = w.cc.GetAccessLog(w.as("alice"), "P-1002")
	requireCode(t, err, "ACCESS_DENIED")
	_, err = w.cc.GetRecordMeta(w.as("alice"), benRec.RecordID)
	requireCode(t, err, "ACCESS_DENIED")

	// A certificate that claims Alice's ehr.id but was issued to another enrollment.
	w.ids["mallory"] = fakes.NewIdentity("Org1MSP", "mallory", "patient", "P-1001")
	_, err = w.cc.ListPatientRecords(w.as("mallory"), "P-1001")
	requireCode(t, err, "ACCESS_DENIED")
	require.Contains(t, err.Error(), "not bound")
}

func TestRoleEscalation(t *testing.T) {
	w, rec := seeded(t)
	_, err := w.cc.CreateRecord(w.asWith("alice", map[string][]byte{"phi": seal("x")}), "P-1001", "lab")
	requireCode(t, err, "ACCESS_DENIED")
	_, err = w.cc.RequestEmergencyAccess(w.as("alice"), "P-1002", "I need this urgently")
	requireCode(t, err, "ACCESS_DENIED")
	_, err = w.cc.RegisterPatient(w.as("alice"), "P-7777", "eve")
	requireCode(t, err, "ACCESS_DENIED")
	_, err = w.cc.DeactivateUser(w.as("chen"), "P-1001")
	requireCode(t, err, "ACCESS_DENIED")
	_, err = w.cc.GrantConsent(w.as("chen"), "D-2001", []string{"*"}, []string{"read"}, "self-grant", w.until(time.Hour))
	requireCode(t, err, "ACCESS_DENIED")

	// A certificate whose role attribute says doctor, for an ID registered as a patient: the
	// role must match the registry kind, so this is not a doctor.
	w.ids["alice-as-doctor"] = fakes.NewIdentity("Org1MSP", "alice", "doctor", "P-1001")
	_, err = w.cc.RequestAccess(w.as("alice-as-doctor"), rec.RecordID, "escalate")
	requireCode(t, err, "ACCESS_DENIED")

	w.ids["norole"] = fakes.NewIdentity("Org1MSP", "norole", "", "P-1001")
	_, err = w.cc.WhoAmI(w.as("norole"))
	requireCode(t, err, "ACCESS_DENIED")
	w.ids["auditor"] = fakes.NewIdentity("Org1MSP", "aud", "auditor", "U-1")
	_, err = w.cc.WhoAmI(w.as("auditor"))
	requireCode(t, err, "ACCESS_DENIED")

	// Admins see metadata, never PHI.
	_, err = w.cc.RequestAccess(w.as("ada"), rec.RecordID, "audit")
	requireCode(t, err, "ACCESS_DENIED")
	list, err := w.cc.ListPatientRecords(w.as("ada"), "P-1001")
	require.NoError(t, err)
	require.Len(t, list, 1)
}

func TestCrossOrg(t *testing.T) {
	w, rec := seeded(t)
	// Rivera (Org2) has no consent from Alice (Org1).
	_, err := w.cc.RequestAccess(w.as("rivera"), rec.RecordID, "second opinion")
	requireCode(t, err, "ACCESS_DENIED")
	_, err = w.cc.ListPatientRecords(w.as("rivera"), "P-1001")
	requireCode(t, err, "ACCESS_DENIED")
	// Org2's admin can't see Org1 patients or manage Org1 members.
	_, err = w.cc.ListPatientRecords(w.as("omar"), "P-1001")
	requireCode(t, err, "ACCESS_DENIED")
	_, err = w.cc.DeactivateUser(w.as("omar"), "D-2001")
	requireCode(t, err, "ACCESS_DENIED")
	// An Org2 certificate carrying an Org1 patient's ID is rejected on MSP mismatch.
	w.ids["alice-org2"] = fakes.NewIdentity("Org2MSP", "alice", "patient", "P-1001")
	_, err = w.cc.WhoAmI(w.as("alice-org2"))
	requireCode(t, err, "ACCESS_DENIED")

	// With consent, cross-org access works and is recorded with Rivera's org.
	w.grantConsent("alice", "D-3001", []string{"lab"}, []string{"read"})
	g, err := w.cc.RequestAccess(w.as("rivera"), rec.RecordID, "second opinion")
	require.NoError(t, err)
	require.Equal(t, "Org2MSP", g.ActorOrg)
}

func TestRevokeAfterGrantDenied(t *testing.T) {
	w := newWorld(t)
	c := w.grantConsent("alice", "D-2001", []string{"lab"}, []string{"read", "append"})
	rec := w.createRecord("chen", "P-1001", "lab", "k+ 4.1")
	g, err := w.cc.RequestAccess(w.as("chen"), rec.RecordID, "review")
	require.NoError(t, err)
	_, err = w.cc.RevokeConsent(w.as("alice"), c.ConsentID)
	require.NoError(t, err)
	_, err = w.cc.ReadRecordPHI(w.as("chen"), g.AccessID)
	requireCode(t, err, "ACCESS_DENIED")
	_, err = w.cc.RevokeConsent(w.as("alice"), c.ConsentID)
	requireCode(t, err, "CONFLICT")
	_, err = w.cc.RequestAccess(w.as("chen"), rec.RecordID, "review")
	requireCode(t, err, "ACCESS_DENIED")
}

func TestExpiredGrantDenied(t *testing.T) {
	w, rec := seeded(t)
	g, err := w.cc.RequestAccess(w.as("chen"), rec.RecordID, "review")
	require.NoError(t, err)
	w.advance(5 * time.Minute)
	_, err = w.cc.ReadRecordPHI(w.as("chen"), g.AccessID)
	requireCode(t, err, "ACCESS_DENIED")
	require.Contains(t, err.Error(), "expired")
}

func TestGrantUsedByAnotherUser(t *testing.T) {
	w, rec := seeded(t)
	w.grantConsent("alice", "D-3001", []string{"lab"}, []string{"read"})
	g, err := w.cc.RequestAccess(w.as("chen"), rec.RecordID, "review")
	require.NoError(t, err)
	_, err = w.cc.ReadRecordPHI(w.as("rivera"), g.AccessID)
	requireCode(t, err, "ACCESS_DENIED")
	_, err = w.cc.ReadRecordPHI(w.as("alice"), g.AccessID)
	requireCode(t, err, "ACCESS_DENIED")
	_, err = w.cc.RecordDelivery(w.as("rivera"), g.AccessID)
	requireCode(t, err, "ACCESS_DENIED")
	_, err = w.cc.ReadRecordPHI(w.as("chen"), "A-doesnotexist")
	requireCode(t, err, "NOT_FOUND")
}

func TestPatientRevokesOutstandingGrants(t *testing.T) {
	w, rec := seeded(t)
	g1, err := w.cc.RequestAccess(w.as("chen"), rec.RecordID, "a")
	require.NoError(t, err)
	g2, err := w.cc.RequestAccess(w.as("chen"), rec.RecordID, "b")
	require.NoError(t, err)
	_, err = w.cc.ReadRecordPHI(w.as("chen"), g2.AccessID)
	require.NoError(t, err)
	_, err = w.cc.RecordDelivery(w.as("chen"), g2.AccessID)
	require.NoError(t, err)

	revoked, err := w.cc.RevokeAccessGrants(w.as("alice"))
	require.NoError(t, err)
	require.Len(t, revoked, 1)
	require.Equal(t, g1.AccessID, revoked[0].AccessID)
	_, err = w.cc.ReadRecordPHI(w.as("chen"), g1.AccessID)
	requireCode(t, err, "ACCESS_DENIED")
	_, err = w.cc.RecordDelivery(w.as("chen"), g1.AccessID)
	requireCode(t, err, "ACCESS_DENIED")
	_, err = w.cc.RevokeAccessGrants(w.as("chen"))
	requireCode(t, err, "ACCESS_DENIED")
}

func TestDeactivationTakesEffectNextTx(t *testing.T) {
	w, rec := seeded(t)
	g, err := w.cc.RequestAccess(w.as("chen"), rec.RecordID, "review")
	require.NoError(t, err)
	_, err = w.cc.SetProviderActive(w.as("ada"), "D-2001", false)
	require.NoError(t, err)
	_, err = w.cc.ReadRecordPHI(w.as("chen"), g.AccessID)
	requireCode(t, err, "ACCESS_DENIED")
	require.Contains(t, err.Error(), "deactivated")
	_, err = w.cc.RequestAccess(w.as("chen"), rec.RecordID, "review")
	requireCode(t, err, "ACCESS_DENIED")

	_, err = w.cc.SetProviderActive(w.as("ada"), "D-2001", true)
	require.NoError(t, err)
	_, err = w.cc.RequestAccess(w.as("chen"), rec.RecordID, "review")
	require.NoError(t, err)

	_, err = w.cc.DeactivateUser(w.as("ada"), "P-1001")
	require.NoError(t, err)
	_, err = w.cc.ListMyConsents(w.as("alice"))
	requireCode(t, err, "ACCESS_DENIED")
	_, err = w.cc.DeactivateUser(w.as("ada"), "A-1001")
	requireCode(t, err, "INVALID")
	_, err = w.cc.GrantConsent(w.as("ben"), "D-2001", []string{"lab"}, []string{"read"}, "x", w.until(time.Hour))
	require.NoError(t, err)
	_, err = w.cc.SetProviderActive(w.as("ada"), "D-2001", false)
	require.NoError(t, err)
	_, err = w.cc.GrantConsent(w.as("ben"), "D-2001", []string{"lab"}, []string{"read"}, "x", w.until(time.Hour))
	requireCode(t, err, "INVALID")
}

func TestConsentValidation(t *testing.T) {
	w := newWorld(t)
	cases := []struct {
		grantee string
		types   []string
		actions []string
		purpose string
		exp     string
		code    string
	}{
		{"D-9999", []string{"lab"}, []string{"read"}, "x", w.until(time.Hour), "NOT_FOUND"},
		{"D-2001", nil, []string{"read"}, "x", w.until(time.Hour), "INVALID"},
		{"D-2001", []string{"dna"}, []string{"read"}, "x", w.until(time.Hour), "INVALID"},
		{"D-2001", []string{"lab"}, []string{"delete"}, "x", w.until(time.Hour), "INVALID"},
		{"D-2001", []string{"lab"}, []string{"read"}, " ", w.until(time.Hour), "INVALID"},
		{"D-2001", []string{"lab"}, []string{"read"}, "x", "next week", "INVALID"},
		{"D-2001", []string{"lab"}, []string{"read"}, "x", w.until(-time.Hour), "INVALID"},
		{"D-2001", []string{"lab"}, []string{"read"}, "x", w.until(400 * 24 * time.Hour), "INVALID"},
	}
	for _, tc := range cases {
		_, err := w.cc.GrantConsent(w.as("alice"), tc.grantee, tc.types, tc.actions, tc.purpose, tc.exp)
		requireCode(t, err, tc.code)
	}
	c, err := w.cc.GrantConsent(w.as("alice"), "D-2001", []string{"lab", "lab", "rx"}, []string{"read"}, "x", w.until(time.Hour))
	require.NoError(t, err)
	require.Equal(t, []string{"lab", "rx"}, c.Types)
	_, err = w.cc.RevokeConsent(w.as("ben"), c.ConsentID)
	requireCode(t, err, "ACCESS_DENIED")
	_, err = w.cc.RevokeConsent(w.as("alice"), "C-nope")
	requireCode(t, err, "NOT_FOUND")
}

func TestListConsentsBothSides(t *testing.T) {
	w := newWorld(t)
	w.grantConsent("alice", "D-2001", []string{"lab"}, []string{"read"})
	w.grantConsent("ben", "D-2001", []string{"rx"}, []string{"read"})
	w.grantConsent("alice", "D-3001", []string{"imaging"}, []string{"read"})

	mine, err := w.cc.ListMyConsents(w.as("alice"))
	require.NoError(t, err)
	require.Len(t, mine, 2)
	toChen, err := w.cc.ListMyConsents(w.as("chen"))
	require.NoError(t, err)
	require.Len(t, toChen, 2)
	_, err = w.cc.ListMyConsents(w.as("ada"))
	requireCode(t, err, "ACCESS_DENIED")

	hist, err := w.cc.GetConsentHistory(w.as("chen"), toChen[0].ConsentID)
	require.NoError(t, err)
	require.Len(t, hist, 1)
	_, err = w.cc.GetConsentHistory(w.as("rivera"), toChen[0].ConsentID)
	requireCode(t, err, "ACCESS_DENIED")
	_, err = w.cc.GetConsentHistory(w.as("ada"), toChen[0].ConsentID)
	require.NoError(t, err)
	_, err = w.cc.GetConsentHistory(w.as("omar"), toChen[0].ConsentID)
	requireCode(t, err, "ACCESS_DENIED")
}

func TestScopedListing(t *testing.T) {
	w := newWorld(t)
	w.grantConsent("alice", "D-2001", []string{"*"}, []string{"append"})
	w.createRecord("chen", "P-1001", "lab", "a")
	w.createRecord("chen", "P-1001", "rx", "b")
	w.createRecord("chen", "P-1001", "imaging", "c")
	w.grantConsent("alice", "D-3001", []string{"lab", "rx"}, []string{"read"})

	riv, err := w.cc.ListPatientRecords(w.as("rivera"), "P-1001")
	require.NoError(t, err)
	require.Len(t, riv, 2)
	self, err := w.cc.ListPatientRecords(w.as("alice"), "P-1001")
	require.NoError(t, err)
	require.Len(t, self, 3)
	_, err = w.cc.ListPatientRecords(w.as("chen"), "P-1001")
	requireCode(t, err, "ACCESS_DENIED") // append-only consent does not allow reading metadata
}

func TestBreakGlass(t *testing.T) {
	w := newWorld(t)
	rec := w.createRecordWithBreakGlass(t)

	_, err := w.cc.RequestEmergencyAccess(w.as("rivera"), "P-1001", "short")
	requireCode(t, err, "INVALID")

	g, err := w.cc.RequestEmergencyAccess(w.as("rivera"), "P-1001", "unconscious in ER, allergy check")
	require.NoError(t, err)
	require.Equal(t, "EmergencyAccess", w.stub.LastEvent().Name)
	ag, err := w.cc.RequestAccess(w.as("rivera"), rec.RecordID, "emergency")
	require.NoError(t, err)
	require.Equal(t, "breakglass:"+g.GrantID, ag.Basis)

	// The review queue belongs to the patient's org.
	q, err := w.cc.ListPendingEmergencyReviews(w.as("omar"))
	require.NoError(t, err)
	require.Empty(t, q)
	q, err = w.cc.ListPendingEmergencyReviews(w.as("ada"))
	require.NoError(t, err)
	require.Len(t, q, 2)
	_, err = w.cc.ReviewEmergencyAccess(w.as("omar"), g.GrantID, "justified", "")
	requireCode(t, err, "ACCESS_DENIED")
	_, err = w.cc.ReviewEmergencyAccess(w.as("ada"), g.GrantID, "maybe", "")
	requireCode(t, err, "INVALID")

	r, err := w.cc.ReviewEmergencyAccess(w.as("ada"), g.GrantID, "unjustified", "no ER visit on record")
	require.NoError(t, err)
	require.True(t, r.Reviewed)
	_, err = w.cc.ReviewEmergencyAccess(w.as("ada"), g.GrantID, "justified", "")
	requireCode(t, err, "CONFLICT")
	_, err = w.cc.ReadRecordPHI(w.as("rivera"), ag.AccessID)
	requireCode(t, err, "ACCESS_DENIED")
	q, err = w.cc.ListPendingEmergencyReviews(w.as("ada"))
	require.NoError(t, err)
	require.Len(t, q, 1)

	log, err := w.cc.GetAccessLog(w.as("alice"), "P-1001")
	require.NoError(t, err)
	require.Len(t, log.Emergency, 2)
	require.Len(t, log.Grants, 1)
}

// createRecordWithBreakGlass has Chen write a record under break-glass, then lets it lapse.
func (w *world) createRecordWithBreakGlass(t *testing.T) *contract.RecordMeta {
	_, err := w.cc.RequestEmergencyAccess(w.as("chen"), "P-1001", "chest pain, patient unresponsive")
	require.NoError(t, err)
	rec := w.createRecord("chen", "P-1001", "allergy", "penicillin")
	w.advance(61 * time.Minute)
	_, err = w.cc.CreateRecord(w.asWith("chen", map[string][]byte{"phi": seal("x")}), "P-1001", "note")
	requireCode(t, err, "ACCESS_DENIED")
	return rec
}

func TestIntegrity(t *testing.T) {
	w, rec := seeded(t)
	r, err := w.cc.VerifyRecordIntegrity(w.as("chen"), rec.RecordID, strings.ToUpper(rec.PHISha256))
	require.NoError(t, err)
	require.True(t, r.Match)
	r, err = w.cc.VerifyRecordIntegrity(w.as("chen"), rec.RecordID, strings.Repeat("0", 64))
	require.NoError(t, err)
	require.False(t, r.Match)
	require.Contains(t, r.Reason, "supplied")

	g, err := w.cc.RequestAccess(w.as("chen"), rec.RecordID, "review")
	require.NoError(t, err)
	w.stub.Private["PHICollection"][rec.RecordID] = seal(`{"test":"HbA1c","value":"4.0%"}`)
	_, err = w.cc.ReadRecordPHI(w.as("chen"), g.AccessID)
	requireCode(t, err, "INTEGRITY")
	r, err = w.cc.VerifyRecordIntegrity(w.as("chen"), rec.RecordID, rec.PHISha256)
	require.NoError(t, err)
	require.False(t, r.Match)
	require.Contains(t, r.Reason, "stored private data")

	// The peer's hash store disagreeing with the ledger is caught too.
	w.stub.Private["PHICollection"][rec.RecordID] = seal(`{"test":"HbA1c","value":"6.1%"}`)
	good := sha256.Sum256(w.stub.Private["PHICollection"][rec.RecordID])
	rec.PHISha256 = hex.EncodeToString(good[:])
	w.stub.Hashes["PHICollection"][rec.RecordID] = make([]byte, 32)
	r, err = w.cc.VerifyRecordIntegrity(w.as("chen"), rec.RecordID, rec.PHISha256)
	require.NoError(t, err)
	require.Contains(t, r.Reason, "private data hash")
}

func TestPurge(t *testing.T) {
	w, rec := seeded(t)
	_, err := w.cc.PurgeRecordPHI(w.as("ada"), rec.RecordID)
	requireCode(t, err, "INVALID")
	_, err = w.cc.RequestRecordPurge(w.as("ben"), rec.RecordID)
	requireCode(t, err, "ACCESS_DENIED")
	_, err = w.cc.RequestRecordPurge(w.as("alice"), rec.RecordID)
	require.NoError(t, err)
	_, err = w.cc.PurgeRecordPHI(w.as("omar"), rec.RecordID)
	requireCode(t, err, "ACCESS_DENIED")
	m, err := w.cc.PurgeRecordPHI(w.as("ada"), rec.RecordID)
	require.NoError(t, err)
	require.True(t, m.Purged)
	require.Nil(t, w.stub.Private["PHICollection"][rec.RecordID])
	_, err = w.cc.RequestAccess(w.as("chen"), rec.RecordID, "review")
	requireCode(t, err, "NOT_FOUND")
	r, err := w.cc.VerifyRecordIntegrity(w.as("alice"), rec.RecordID, rec.PHISha256)
	require.NoError(t, err)
	require.Contains(t, r.Reason, "purged")
	_, err = w.cc.PurgeRecordPHI(w.as("ada"), rec.RecordID)
	requireCode(t, err, "CONFLICT")

	hist, err := w.cc.GetRecordHistory(w.as("alice"), rec.RecordID)
	require.NoError(t, err)
	require.Len(t, hist, 3)
	var newest contract.RecordMeta
	require.NoError(t, json.Unmarshal([]byte(hist[0].Value), &newest))
	require.True(t, newest.Purged)
}

func TestAuditReconcile(t *testing.T) {
	w, rec := seeded(t)
	g1, _ := w.cc.RequestAccess(w.as("chen"), rec.RecordID, "a")
	g2, _ := w.cc.RequestAccess(w.as("chen"), rec.RecordID, "b")
	_, err := w.cc.RecordDelivery(w.as("chen"), g1.AccessID)
	require.NoError(t, err)
	r, err := w.cc.AuditReconcile(w.as("alice"), "P-1001")
	require.NoError(t, err)
	require.Equal(t, 1, r.Delivered)
	require.Equal(t, 1, r.Pending)
	w.advance(10 * time.Minute)
	r, err = w.cc.AuditReconcile(w.as("ada"), "P-1001")
	require.NoError(t, err)
	require.Equal(t, 1, r.ExpiredUnused)
	_ = g2
	_, err = w.cc.AuditReconcile(w.as("chen"), "P-1001")
	requireCode(t, err, "ACCESS_DENIED")
	_, err = w.cc.AuditReconcile(w.as("omar"), "P-1001")
	requireCode(t, err, "ACCESS_DENIED")
}

func TestRegistry(t *testing.T) {
	w := newWorld(t)
	_, err := w.cc.BootstrapAdmin(w.as("ada"))
	requireCode(t, err, "CONFLICT")
	_, err = w.cc.BootstrapAdmin(w.as("alice"))
	requireCode(t, err, "ACCESS_DENIED")
	_, err = w.cc.RegisterPatient(w.as("ada"), "D-2001", "someone")
	requireCode(t, err, "CONFLICT")
	_, err = w.cc.RegisterPatient(w.as("ada"), "P 1", "x")
	requireCode(t, err, "INVALID")
	_, err = w.cc.RegisterAdmin(w.as("ada"), "A-1002", "grace")
	require.NoError(t, err)
	w.ids["grace"] = fakes.NewIdentity("Org1MSP", "grace", "admin", "A-1002")
	members, err := w.cc.ListOrgMembers(w.as("grace"))
	require.NoError(t, err)
	require.Len(t, members, 5)
	provs, err := w.cc.ListProviders(w.as("alice"))
	require.NoError(t, err)
	require.Len(t, provs, 2)
	m, err := w.cc.GetMember(w.as("alice"), "D-3001")
	require.NoError(t, err)
	require.Equal(t, "Org2MSP", m.Org)
	// Patient entries are not a public directory.
	_, err = w.cc.GetMember(w.as("alice"), "P-1002")
	requireCode(t, err, "ACCESS_DENIED")
	_, err = w.cc.GetMember(w.as("rivera"), "P-1001")
	requireCode(t, err, "ACCESS_DENIED")
	_, err = w.cc.GetMember(w.as("omar"), "P-1001")
	requireCode(t, err, "ACCESS_DENIED")
	_, err = w.cc.GetMember(w.as("alice"), "A-1001")
	requireCode(t, err, "ACCESS_DENIED")
	_, err = w.cc.GetMember(w.as("ada"), "P-1001")
	require.NoError(t, err)
	_, err = w.cc.GetMember(w.as("alice"), "P-1001")
	require.NoError(t, err)
	w.grantConsent("alice", "D-3001", []string{"lab"}, []string{"read"})
	_, err = w.cc.GetMember(w.as("rivera"), "P-1001")
	require.NoError(t, err)
	_, err = w.cc.GetMember(w.as("alice"), "D-0000")
	requireCode(t, err, "NOT_FOUND")
	who, err := w.cc.WhoAmI(w.as("rivera"))
	require.NoError(t, err)
	require.Equal(t, "D-3001", who.ID)
	_, err = w.cc.SetProviderActive(w.as("ada"), "P-1001", false)
	requireCode(t, err, "NOT_FOUND")
	p, err := w.cc.Ping(w.as("probe"))
	require.NoError(t, err)
	require.True(t, p.OK)
}

func TestBackdatedProposalsRejected(t *testing.T) {
	w, rec := seeded(t)
	real := w.now
	// The gateway stamps the proposal an hour in the past; the peer's clock says otherwise.
	contract.WallClock = func() time.Time { return real.Add(time.Hour) }
	_, err := w.cc.RequestAccess(w.as("chen"), rec.RecordID, "backdated")
	requireCode(t, err, "INVALID")
	_, err = w.cc.GrantConsent(w.as("alice"), "D-3001", []string{"lab"}, []string{"read"}, "x", w.until(24*time.Hour))
	requireCode(t, err, "INVALID")
	_, err = w.cc.RequestEmergencyAccess(w.as("rivera"), "P-1001", "backdated emergency reason")
	requireCode(t, err, "INVALID")
	_, err = w.cc.CreateRecord(w.asWith("chen", map[string][]byte{"phi": seal("backdated note")}), "P-1001", "lab")
	requireCode(t, err, "INVALID")
	// Small skew is fine.
	contract.WallClock = func() time.Time { return w.now.Add(90 * time.Second) }
	_, err = w.cc.RequestAccess(w.as("chen"), rec.RecordID, "ok")
	require.NoError(t, err)
}

func TestMissingPrivateDataIsUnavailableNotNotFound(t *testing.T) {
	w, rec := seeded(t)
	g, err := w.cc.RequestAccess(w.as("chen"), rec.RecordID, "review")
	require.NoError(t, err)
	delete(w.stub.Private["PHICollection"], rec.RecordID)
	_, err = w.cc.ReadRecordPHI(w.as("chen"), g.AccessID)
	requireCode(t, err, "PHI_UNAVAILABLE")
	r, err := w.cc.VerifyRecordIntegrity(w.as("alice"), rec.RecordID, rec.PHISha256)
	require.NoError(t, err)
	require.Contains(t, r.Reason, "no copy")
}

func TestPHIMustBeSalted(t *testing.T) {
	w := newWorld(t)
	w.grantConsent("alice", "D-2001", []string{"rx"}, []string{"append"})
	for _, bad := range []string{`{"drug":"Atorvastatin"}`, `{"salt":"c2hvcnQ=","data":"x"}`, `{"salt":"` + base64.StdEncoding.EncodeToString(make([]byte, 32)) + `"}`} {
		_, err := w.cc.CreateRecord(w.asWith("chen", map[string][]byte{"phi": []byte(bad)}), "P-1001", "rx")
		requireCode(t, err, "INVALID")
	}
	// Same content, different salts: different public digests.
	a := w.createRecord("chen", "P-1001", "rx", "atorvastatin 20 mg")
	b, err := w.cc.CreateRecord(w.asWith("chen", map[string][]byte{"phi": []byte(`{"salt":"` + base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")) + `","data":"atorvastatin 20 mg"}`)}), "P-1001", "rx")
	require.NoError(t, err)
	require.NotEqual(t, a.PHISha256, b.PHISha256)
}
