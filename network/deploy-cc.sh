#!/usr/bin/env bash
# Deploy the ehr chaincode with the PHI private data collection. No -ccep: the channel default
# (MAJORITY of Org1 and Org2) applies, so both hospitals endorse every write.
# Usage: deploy-cc.sh [channel...]   (default: ehrchannel)
set -euo pipefail
source "$(dirname "$0")/env.sh"
cd "$TN"
channels=("$@")
[ ${#channels[@]} -eq 0 ] && channels=("$CHANNEL_BFT")
for ch in "${channels[@]}"; do
  ./network.sh deployCC -c "$ch" -ccn "$CC_NAME" -ccp "$ROOT/chaincode/ehr" -ccl go \
    -cccg "$ROOT/chaincode/ehr/collections_config.json" -ccv "${CC_VERSION:-1.0}" -ccs "${CC_SEQUENCE:-1}"
done
