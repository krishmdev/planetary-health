#!/usr/bin/env bash
# Create ehrraft (etcdraft) on the four orderers that already run ehrchannel (BFT), join both
# peers, and set anchor peers.
set -euo pipefail
source "$(dirname "$0")/env.sh"
cd "$TN"
cfg="$TN/raft-config"
mkdir -p "$cfg" channel-artifacts
{ cat bft-config/configtx.yaml; printf '\n'; cat "$ROOT/network/configtx-raft/profile.yaml"; } > "$cfg/configtx.yaml"
FABRIC_CFG_PATH="$cfg" configtxgen -profile ChannelUsingRaft4 -outputBlock "channel-artifacts/$CHANNEL_RAFT.block" -channelID "$CHANNEL_RAFT"

ORDERER_CA="$TN/organizations/ordererOrganizations/example.com/tlsca/tlsca.example.com-cert.pem"
i=0
for o in orderer orderer2 orderer3 orderer4; do
  port=$((7053 + 2 * i)); i=$((i + 1))
  tls="$TN/organizations/ordererOrganizations/example.com/orderers/$o.example.com/tls"
  osnadmin channel join --channelID "$CHANNEL_RAFT" --config-block "channel-artifacts/$CHANNEL_RAFT.block" \
    -o "localhost:$port" --ca-file "$ORDERER_CA" --client-cert "$tls/server.crt" --client-key "$tls/server.key"
done

export FABRIC_CFG_PATH="$SAMPLES/config"
set +u; . scripts/envVar.sh; set -u
for org in 1 2; do
  set +u; setGlobals $org; set -u
  for _ in 1 2 3 4 5; do
    peer channel join -b "channel-artifacts/$CHANNEL_RAFT.block" && break
    sleep 2
  done
done
set +u
for org in 1 2; do . scripts/setAnchorPeer.sh $org "$CHANNEL_RAFT"; done
set -u
echo "channel $CHANNEL_RAFT ready"
