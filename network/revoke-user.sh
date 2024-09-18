#!/usr/bin/env bash
# Second revocation layer: revoke an Org1 enrollment at the CA, generate a CRL, and add it to
# Org1MSP's channel config so every peer rejects the certificate at MSP validation.
# (The first layer, DeactivateUser on the on-chain registry, takes effect at the next block.)
# Usage: revoke-user.sh <enrollmentId> [channel...]
set -euo pipefail
source "$(dirname "$0")/env.sh"
cd "$TN"
id="$1"; shift
channels=("$@")
[ ${#channels[@]} -eq 0 ] && channels=("$CHANNEL_BFT")
ORG_DIR="$TN/organizations/peerOrganizations/org1.example.com"
CA_TLS="$TN/organizations/fabric-ca/org1/ca-cert.pem"
export FABRIC_CA_CLIENT_HOME="$ORG_DIR"

fabric-ca-client revoke --caname ca-org1 -e "$id" -r keycompromise --gencrl --tls.certfiles "$CA_TLS"
crl="$ORG_DIR/msp/crls/crl.pem"
[ -s "$crl" ] || { echo "no CRL at $crl" >&2; exit 1; }
crl_b64=$(base64 < "$crl" | tr -d '\n')

export FABRIC_CFG_PATH="$SAMPLES/config"
set +u; . scripts/configUpdate.sh; set -u
mkdir -p channel-artifacts
for ch in "${channels[@]}"; do
  set +u
  fetchChannelConfig 1 "$ch" "channel-artifacts/${ch}_config.json"
  set -u
  jq --arg crl "$crl_b64" \
    '.channel_group.groups.Application.groups.Org1MSP.values.MSP.value.config.revocation_list = [$crl]' \
    "channel-artifacts/${ch}_config.json" > "channel-artifacts/${ch}_modified.json"
  set +u
  createConfigUpdate "$ch" "channel-artifacts/${ch}_config.json" "channel-artifacts/${ch}_modified.json" "channel-artifacts/${ch}_crl_update.pb"
  setGlobals 1
  set -u
  peer channel update -f "channel-artifacts/${ch}_crl_update.pb" -c "$ch" -o localhost:7050 \
    --ordererTLSHostnameOverride orderer.example.com --tls --cafile "$ORDERER_CA"
  echo "CRL for $id added to Org1MSP on $ch"
done
