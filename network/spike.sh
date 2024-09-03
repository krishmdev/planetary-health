#!/usr/bin/env bash
# First-hour spike: stock asset-transfer-basic on the BFT test network, one orderer stopped.
# Run under the compute lease; tears the network down at the end.
set -euo pipefail
source "$(dirname "$0")/env.sh"
cd "$TN"

./network.sh down >/dev/null 2>&1 || true
./network.sh up createChannel -bft -ca -c "$CHANNEL_BFT"
./network.sh deployCC -c "$CHANNEL_BFT" -ccn basic -ccp ../asset-transfer-basic/chaincode-go -ccl go

export FABRIC_CFG_PATH="$SAMPLES/config"
set +u; . scripts/envVar.sh
setGlobals 1; set -u
PEERS=(--peerAddresses localhost:7051 --tlsRootCertFiles "$PEER0_ORG1_CA"
       --peerAddresses localhost:9051 --tlsRootCertFiles "$PEER0_ORG2_CA")
invoke() {
  peer chaincode invoke -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com --tls \
    --cafile "$ORDERER_CA" -C "$CHANNEL_BFT" -n basic "${PEERS[@]}" --waitForEvent -c "$1"
}

invoke '{"function":"InitLedger","Args":[]}'
echo "leader id: $(curl -s localhost:9443/metrics | grep '^consensus_BFT_leader_id' || true)"
docker stop orderer4.example.com
invoke '{"function":"CreateAsset","Args":["spike1","blue","5","Krish","100"]}'
peer chaincode query -C "$CHANNEL_BFT" -n basic -c '{"Args":["ReadAsset","spike1"]}'
echo "SPIKE OK: committed with orderer4 stopped"
docker start orderer4.example.com

if [ "${KEEP:-0}" != "1" ]; then ./network.sh down; fi
