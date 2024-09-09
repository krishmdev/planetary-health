package fakes

import (
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"fmt"

	"github.com/hyperledger/fabric-chaincode-go/v2/pkg/cid"
	"github.com/hyperledger/fabric-chaincode-go/v2/shim"
)

// Identity is a fake client certificate: an MSP, an enrollment ID (the cert CN), and CA
// attributes such as ehr.role and ehr.id.
type Identity struct {
	MSPID        string
	EnrollmentID string
	Issuer       string
	Attrs        map[string]string
}

func NewIdentity(msp, enrollmentID, role, ehrID string) *Identity {
	attrs := map[string]string{}
	if role != "" {
		attrs["ehr.role"] = role
	}
	if ehrID != "" {
		attrs["ehr.id"] = ehrID
	}
	return &Identity{MSPID: msp, EnrollmentID: enrollmentID, Issuer: "ca." + msp, Attrs: attrs}
}

// GetID mirrors cid's format: base64("x509::<subject>::<issuer>").
func (i *Identity) GetID() (string, error) {
	raw := fmt.Sprintf("x509::CN=%s::CN=%s", i.EnrollmentID, i.Issuer)
	return base64.StdEncoding.EncodeToString([]byte(raw)), nil
}

func (i *Identity) GetMSPID() (string, error) { return i.MSPID, nil }

func (i *Identity) GetAttributeValue(name string) (string, bool, error) {
	v, ok := i.Attrs[name]
	return v, ok, nil
}

func (i *Identity) AssertAttributeValue(name, value string) error {
	if v, ok := i.Attrs[name]; !ok || v != value {
		return fmt.Errorf("attribute %s is not %s", name, value)
	}
	return nil
}

func (i *Identity) GetX509Certificate() (*x509.Certificate, error) {
	return &x509.Certificate{Subject: pkix.Name{CommonName: i.EnrollmentID}, Issuer: pkix.Name{CommonName: i.Issuer}}, nil
}

var _ cid.ClientIdentity = (*Identity)(nil)

// Context implements contractapi.TransactionContextInterface over a Stub and an Identity.
type Context struct {
	Stub     *Stub
	Identity *Identity
}

func (c *Context) GetStub() shim.ChaincodeStubInterface  { return c.Stub }
func (c *Context) GetClientIdentity() cid.ClientIdentity { return c.Identity }
