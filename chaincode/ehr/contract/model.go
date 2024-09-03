package contract

const (
	RolePatient = "patient"
	RoleDoctor  = "doctor"
	RoleAdmin   = "admin"
)

var recordTypes = map[string]bool{"lab": true, "imaging": true, "note": true, "rx": true, "allergy": true}

// Member is an on-chain registry entry. It binds an ehr.id to one enrollment in one org and
// carries the active flag. Roles come from the certificate, never from here.
type Member struct {
	ID           string `json:"id"`
	Role         string `json:"role"`
	Org          string `json:"org"`
	EnrollmentID string `json:"enrollmentId"`
	Specialty    string `json:"specialty,omitempty"`
	Active       bool   `json:"active"`
	RegisteredBy string `json:"registeredBy"`
	UpdatedAt    string `json:"updatedAt"`
}

type RecordMeta struct {
	RecordID       string `json:"recordId"`
	PatientID      string `json:"patientId"`
	Type           string `json:"type"`
	CreatedBy      string `json:"createdBy"`
	Org            string `json:"org"`
	CreatedAt      string `json:"createdAt"`
	PHISha256      string `json:"phiSha256"`
	Version        int    `json:"version"`
	PurgeRequested bool   `json:"purgeRequested"`
	Purged         bool   `json:"purged"`
	PurgedAt       string `json:"purgedAt,omitempty"`
}

type Consent struct {
	ConsentID string   `json:"consentId"`
	PatientID string   `json:"patientId"`
	Grantee   string   `json:"grantee"`
	Types     []string `json:"types"`
	Actions   []string `json:"actions"`
	Purpose   string   `json:"purpose"`
	Status    string   `json:"status"`
	CreatedAt string   `json:"createdAt"`
	ExpiresAt string   `json:"expiresAt"`
	RevokedAt string   `json:"revokedAt,omitempty"`
}

type BreakGlass struct {
	GrantID     string `json:"grantId"`
	PatientID   string `json:"patientId"`
	ProviderID  string `json:"providerId"`
	ProviderOrg string `json:"providerOrg"`
	PatientOrg  string `json:"patientOrg"`
	Reason      string `json:"reason"`
	CreatedAt   string `json:"createdAt"`
	ExpiresAt   string `json:"expiresAt"`
	Reviewed    bool   `json:"reviewed"`
	Outcome     string `json:"outcome,omitempty"`
	ReviewedBy  string `json:"reviewedBy,omitempty"`
	ReviewNote  string `json:"reviewNote,omitempty"`
}

// AccessGrant is the on-ledger authorization for one PHI delivery. It is written by a
// MAJORITY-endorsed submit; the delivery itself happens off-ledger through an evaluate.
type AccessGrant struct {
	AccessID    string `json:"accessId"`
	PatientID   string `json:"patientId"`
	RecordID    string `json:"recordId"`
	RecordType  string `json:"recordType"`
	Actor       string `json:"actor"`
	ActorCertID string `json:"actorCertId"`
	ActorOrg    string `json:"actorOrg"`
	Role        string `json:"role"`
	Purpose     string `json:"purpose"`
	Basis       string `json:"basis"`
	Nonce       string `json:"nonce"`
	Status      string `json:"status"` // granted | delivered | revoked
	CreatedAt   string `json:"createdAt"`
	ExpiresAt   string `json:"expiresAt"`
	DeliveredAt string `json:"deliveredAt,omitempty"`
	DeliveryTx  string `json:"deliveryTx,omitempty"`
}

const (
	GrantGranted   = "granted"
	GrantDelivered = "delivered"
	GrantRevoked   = "revoked"
)

type PHIResponse struct {
	AccessID  string `json:"accessId"`
	RecordID  string `json:"recordId"`
	PatientID string `json:"patientId"`
	Type      string `json:"type"`
	PHI       string `json:"phi"`
	PHISha256 string `json:"phiSha256"`
	Basis     string `json:"basis"`
}

type HistoryEntry struct {
	TxID      string `json:"txId"`
	Timestamp string `json:"timestamp"`
	IsDelete  bool   `json:"isDelete"`
	Value     string `json:"value"`
}

type IntegrityReport struct {
	RecordID    string `json:"recordId"`
	OnLedger    string `json:"onLedger"`
	Supplied    string `json:"supplied"`
	PrivateHash string `json:"privateHash"`
	Match       bool   `json:"match"`
	Reason      string `json:"reason,omitempty"`
}

type ReconcileReport struct {
	PatientID     string        `json:"patientId"`
	Grants        []AccessGrant `json:"grants"`
	Delivered     int           `json:"delivered"`
	Pending       int           `json:"pending"`
	ExpiredUnused int           `json:"expiredUnused"`
	Revoked       int           `json:"revoked"`
}

type WhoAmI struct {
	ID           string `json:"id"`
	Role         string `json:"role"`
	Org          string `json:"org"`
	EnrollmentID string `json:"enrollmentId"`
	CertID       string `json:"certId"`
}

type PingResult struct {
	OK     bool   `json:"ok"`
	MSPID  string `json:"mspId"`
	TxTime string `json:"txTime"`
}
