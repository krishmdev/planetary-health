#!/usr/bin/env bash
# Fetch fabric-samples at the pinned commit, plus Fabric binaries and images.
set -euo pipefail
source "$(dirname "$0")/env.sh"

mkdir -p "$FABRIC_DIR"
if [ ! -d "$SAMPLES/.git" ]; then
  git clone --quiet https://github.com/hyperledger/fabric-samples.git "$SAMPLES"
fi
git -C "$SAMPLES" fetch --quiet origin
git -C "$SAMPLES" -c advice.detachedHead=false checkout --quiet "$SAMPLES_SHA"
echo "fabric-samples at $(git -C "$SAMPLES" rev-parse --short HEAD)"

if [ ! -x "$SAMPLES/bin/peer" ] || ! "$SAMPLES/bin/peer" version | grep -q "Version: v$FABRIC_VERSION"; then
  curl -sSL "https://raw.githubusercontent.com/hyperledger/fabric/v$FABRIC_VERSION/scripts/install-fabric.sh" \
    -o "$FABRIC_DIR/install-fabric.sh"
  chmod +x "$FABRIC_DIR/install-fabric.sh"
  (cd "$SAMPLES" && "$FABRIC_DIR/install-fabric.sh" --fabric-version "$FABRIC_VERSION" --ca-version "$CA_VERSION" binary)
fi

for img in peer orderer ccenv baseos; do
  docker image inspect "hyperledger/fabric-$img:$FABRIC_VERSION" >/dev/null 2>&1 \
    || docker pull --quiet "hyperledger/fabric-$img:$FABRIC_VERSION"
done
docker image inspect "hyperledger/fabric-ca:$CA_VERSION" >/dev/null 2>&1 \
  || docker pull --quiet "hyperledger/fabric-ca:$CA_VERSION"
# test-network compose files use the short tags
for img in peer orderer ccenv baseos; do
  docker tag "hyperledger/fabric-$img:$FABRIC_VERSION" "hyperledger/fabric-$img:latest"
done
docker tag "hyperledger/fabric-ca:$CA_VERSION" hyperledger/fabric-ca:latest

peer version | head -3
fabric-ca-client version | head -2
