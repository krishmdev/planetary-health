#!/usr/bin/env bash
# 4 SmartBFT orderers (f=1), Fabric CAs, one peer each for Org1 (Mercy General) and Org2
# (Riverside Clinic), channel ehrchannel.
set -euo pipefail
source "$(dirname "$0")/env.sh"
cd "$TN"
./network.sh up createChannel -bft -ca -c "$CHANNEL_BFT"
