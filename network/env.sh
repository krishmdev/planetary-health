# Version pins for the local Fabric network. Sourced by every network script.
export FABRIC_VERSION=3.1.5
export CA_VERSION=1.5.22
# fabric-samples has no 3.x tag; this commit is "Update Fabric to v2.5.16 and v3.1.5".
export SAMPLES_SHA=119d3bc53f
export CHANNEL_BFT=ehrchannel
export CHANNEL_RAFT=ehrraft
export CC_NAME=ehr

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ROOT
export FABRIC_DIR="$ROOT/.fabric"
export SAMPLES="$FABRIC_DIR/fabric-samples"
export TN="$SAMPLES/test-network"
export PATH="$SAMPLES/bin:$PATH"
export FABRIC_CFG_PATH="$SAMPLES/config"
