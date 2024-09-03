package contract

// The caller's identity comes only from the transaction's creator certificate (cid). No
// transaction accepts a role or caller ID as an argument.

const (
	attrRole = "ehr.role"
	attrID   = "ehr.id"
)

type certIdentity struct {
	Role, ID, Org, EnrollmentID, CertID string
}

func readCert(ctx Ctx) (*certIdentity, error) {
	ci := ctx.GetClientIdentity()
	msp, err := ci.GetMSPID()
	if err != nil {
		return nil, err
	}
	certID, err := ci.GetID()
	if err != nil {
		return nil, err
	}
	cert, err := ci.GetX509Certificate()
	if err != nil {
		return nil, err
	}
	if cert == nil {
		return nil, errDenied("caller has no X.509 certificate")
	}
	role, ok, err := ci.GetAttributeValue(attrRole)
	if err != nil {
		return nil, err
	}
	if !ok || role == "" {
		return nil, errDenied("certificate carries no %s attribute", attrRole)
	}
	id, ok, err := ci.GetAttributeValue(attrID)
	if err != nil {
		return nil, err
	}
	if !ok || id == "" {
		return nil, errDenied("certificate carries no %s attribute", attrID)
	}
	return &certIdentity{Role: role, ID: id, Org: msp, EnrollmentID: cert.Subject.CommonName, CertID: certID}, nil
}

// currentActor resolves the caller and checks it against the on-chain registry: the entry must
// exist for the certificate's role, belong to the same MSP, be bound to the same enrollment,
// and be active. Because the registry key is read during simulation, a deactivation that
// commits first invalidates this transaction at validation (MVCC).
func currentActor(ctx Ctx) (*Actor, error) {
	c, err := readCert(ctx)
	if err != nil {
		return nil, err
	}
	obj, ok := memberObject[c.Role]
	if !ok {
		return nil, errDenied("unknown role %q", c.Role)
	}
	m, err := getObj[Member](ctx, obj, c.ID)
	if err != nil {
		return nil, err
	}
	if m == nil {
		return nil, errDenied("%s %s is not registered", c.Role, c.ID)
	}
	if m.Org != c.Org {
		return nil, errDenied("%s is registered to %s, not %s", c.ID, m.Org, c.Org)
	}
	if m.EnrollmentID != c.EnrollmentID {
		return nil, errDenied("certificate %q is not bound to %s", c.EnrollmentID, c.ID)
	}
	if !m.Active {
		return nil, errDenied("%s is deactivated", c.ID)
	}
	return &Actor{ID: c.ID, Role: c.Role, Org: c.Org, EnrollmentID: c.EnrollmentID, CertID: c.CertID, Active: true}, nil
}

func requireRole(ctx Ctx, roles ...string) (*Actor, error) {
	a, err := currentActor(ctx)
	if err != nil {
		return nil, err
	}
	for _, r := range roles {
		if a.Role == r {
			return a, nil
		}
	}
	return nil, errDenied("role %s cannot call this transaction", a.Role)
}

func getPatient(ctx Ctx, pid string) (*Member, error) {
	p, err := getObj[Member](ctx, objPatient, pid)
	if err != nil {
		return nil, err
	}
	if p == nil {
		return nil, errNotFound("patient %s", pid)
	}
	return p, nil
}
