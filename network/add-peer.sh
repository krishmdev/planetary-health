#!/usr/bin/env bash
# Add peer1.org1 as a read replica: enroll it with the Org1 CA, start it, join ehrchannel and
# install the ehr chaincode package that deploy-cc.sh built.
set -euo pipefail
source "$(dirname "$0")/env.sh"
cd "$TN"
ORG_DIR="$TN/organizations/peerOrganizations/org1.example.com"
P="$ORG_DIR/peers/peer1.org1.example.com"
CA_TLS="$TN/organizations/fabric-ca/org1/ca-cert.pem"
export FABRIC_CA_CLIENT_HOME="$ORG_DIR"

if [ ! -f "$P/tls/server.key" ]; then
  fabric-ca-client register --caname ca-org1 --id.name peer1 --id.secret peer1pw --id.type peer --tls.certfiles "$CA_TLS" || true
  fabric-ca-client enroll -u https://peer1:peer1pw@localhost:7054 --caname ca-org1 -M "$P/msp" --tls.certfiles "$CA_TLS"
  cp "$ORG_DIR/msp/config.yaml" "$P/msp/config.yaml"
  fabric-ca-client enroll -u https://peer1:peer1pw@localhost:7054 --caname ca-org1 -M "$P/tls" \
    --enrollment.profile tls --csr.hosts peer1.org1.example.com --csr.hosts localhost --tls.certfiles "$CA_TLS"
  cp "$P"/tls/tlscacerts/* "$P/tls/ca.crt"
  cp "$P"/tls/signcerts/* "$P/tls/server.crt"
  cp "$P"/tls/keystore/* "$P/tls/server.key"
fi

TN="$TN" docker compose -p planetary-peer1 -f "$ROOT/network/compose-peer1.yaml" up -d

export FABRIC_CFG_PATH="$SAMPLES/config"
set +u; . scripts/envVar.sh; setGlobals 1; set -u
export CORE_PEER_ADDRESS=localhost:8051
for _ in $(seq 1 10); do
  peer channel join -b "channel-artifacts/$CHANNEL_BFT.block" && break
  sleep 2
done
peer lifecycle chaincode install "$CC_NAME.tar.gz" || true
peer lifecycle chaincode queryinstalled
echo "peer1.org1 joined $CHANNEL_BFT"
