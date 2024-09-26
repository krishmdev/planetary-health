#!/usr/bin/env bash
# Tear down everything this repo starts: app stack, read replica, test network.
set -uo pipefail
source "$(dirname "$0")/env.sh"
[ -f "$ROOT/.env" ] && docker compose -p planetary-app -f "$ROOT/compose.app.yaml" --env-file "$ROOT/.env" down --remove-orphans 2>/dev/null
TN="$TN" docker compose -p planetary-peer1 -f "$ROOT/network/compose-peer1.yaml" down -v 2>/dev/null
rm -rf "$TN/organizations/peerOrganizations/org1.example.com/peers/peer1.org1.example.com"
cd "$TN" && ./network.sh down
rm -rf "$ROOT/.wallet" "$ROOT/.data/org1" "$ROOT/.data/org2" "$TN/raft-config"
