package main

import (
	"encoding/json"
	"testing"

	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
	"github.com/krishmdev/planetary-health/chaincode/ehr/contract"
)

// contract-api reflects over every exported method at startup and refuses types it can't
// describe. Catch that here rather than at deploy time.
func TestContractMetadata(t *testing.T) {
	cc, err := contractapi.NewChaincode(&contract.EHRContract{})
	if err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(cc.Info)
	if err != nil || len(b) == 0 {
		t.Fatal("no chaincode info")
	}
}
