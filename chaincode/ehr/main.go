package main

import (
	"log"

	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
	"github.com/krishmdev/planetary-health/chaincode/ehr/contract"
)

func main() {
	cc, err := contractapi.NewChaincode(&contract.EHRContract{})
	if err != nil {
		log.Fatalf("create chaincode: %v", err)
	}
	cc.Info.Title = "ehr"
	cc.Info.Version = "1.0"
	if err := cc.Start(); err != nil {
		log.Fatalf("start chaincode: %v", err)
	}
}
