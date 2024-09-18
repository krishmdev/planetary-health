#!/usr/bin/env bash
# Full local network: BFT channel, Raft comparison channel on the same orderers, chaincode on
# both, the peer1.org1 read replica, and the seeded demo users. Takes a few minutes.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/env.sh"
[ -f "$ROOT/.env" ] || cp "$ROOT/.env.example" "$ROOT/.env"
set -a; source "$ROOT/.env"; set +a

"$here/up.sh"
"$here/create-raft-channel.sh"
"$here/deploy-cc.sh" "$CHANNEL_BFT" "$CHANNEL_RAFT"
"$here/add-peer.sh"
(cd "$ROOT/gateway" && pnpm exec tsx src/seed.ts)
docker ps --format '{{.Names}}\t{{.Status}}' | sort
