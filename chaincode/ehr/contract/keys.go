package contract

// Composite-key object types. Public state never holds PHI; PHI lives in PHICollection.
const (
	objPatient   = "patient"  // patient~{pid}
	objProvider  = "provider" // provider~{did}
	objAdmin     = "admin"    // admin~{aid}
	objOrgAdmin  = "orgadmin" // orgadmin~{msp}: set once an org has bootstrapped its first admin
	objRecord    = "rec"      // rec~{pid}~{rid}
	objRecordIdx = "recidx"   // recidx~{rid} -> pid
	objConsent   = "consent"  // consent~{pid}~{grantee}~{cid}
	objConsentIx = "considx"  // considx~{cid} -> {pid, grantee}
	objGrantee   = "grantee"  // grantee~{did}~{pid}~{cid} (index for "patients who consented to me")
	objBreak     = "bg"       // bg~{pid}~{gid}
	objBreakIdx  = "bgidx"    // bgidx~{gid} -> pid
	objReviewQ   = "bgq"      // bgq~{patientOrg}~{gid}: pending break-glass reviews
	objAccess    = "access"   // access~{pid}~{accessId}
	objAccessIdx = "accidx"   // accidx~{accessId} -> pid

	phiCollection = "PHICollection"
)

// memberRoles fixes the lookup order. Ranging over the map would give each endorser a
// different read set.
var memberRoles = []string{RolePatient, RoleDoctor, RoleAdmin}

var memberObject = map[string]string{
	RolePatient: objPatient,
	RoleDoctor:  objProvider,
	RoleAdmin:   objAdmin,
}
