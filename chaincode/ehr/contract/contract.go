package contract

import "github.com/hyperledger/fabric-contract-api-go/v2/contractapi"

// EHRContract is the ehr chaincode. Every exported method is a transaction.
type EHRContract struct {
	contractapi.Contract
}

// Ping is side-effect free and needs no registry entry. The gateway endorses it (without
// submitting) on both orgs' peers as a readiness probe.
func (c *EHRContract) Ping(ctx Ctx) (*PingResult, error) {
	msp, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return nil, err
	}
	now, err := txTime(ctx)
	if err != nil {
		return nil, err
	}
	return &PingResult{OK: true, MSPID: msp, TxTime: stamp(now)}, nil
}

func (c *EHRContract) WhoAmI(ctx Ctx) (*WhoAmI, error) {
	a, err := currentActor(ctx)
	if err != nil {
		return nil, err
	}
	return &WhoAmI{ID: a.ID, Role: a.Role, Org: a.Org, EnrollmentID: a.EnrollmentID, CertID: a.CertID}, nil
}
