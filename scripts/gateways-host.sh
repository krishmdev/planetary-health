#!/usr/bin/env bash
# Run four gateway processes on the host for the e2e (logs in .data/logs). Ctrl-C stops them.
#   :8080 org1 (reads on peer0)      :8081 org2
#   :8082 org1 reads on peer1 replica :8083 same, FRESHNESS=off (negative control only)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
set -a; source "$root/.env"; set +a
mkdir -p "$root/.data/logs"
cd "$root/gateway"
export NODE_OPTIONS=--no-warnings=ExperimentalWarning
pids=()
run() {
  local name=$1; shift
  env "$@" pnpm exec tsx src/server.ts > "$root/.data/logs/$name.log" 2>&1 &
  pids+=($!)
}
run org1 ORG=org1 PORT=8080
run org2 ORG=org2 PORT=8081
run org1-replica ORG=org1 PORT=8082 READ_PEER_ENDPOINT=localhost:8051 READ_PEER_HOST_ALIAS=peer1.org1.example.com DATA_DIR="$root/.data/org1-replica"
run org1-control ORG=org1 PORT=8083 READ_PEER_ENDPOINT=localhost:8051 READ_PEER_HOST_ALIAS=peer1.org1.example.com DATA_DIR="$root/.data/org1-control" FRESHNESS=off
trap 'kill "${pids[@]}" 2>/dev/null' EXIT INT TERM
for port in 8080 8081 8082 8083; do
  for _ in $(seq 1 60); do curl -sf "localhost:$port/healthz" >/dev/null && break; sleep 0.5; done
done
echo "gateways up: ${pids[*]}"
if [ "${1:-}" = "--detach" ]; then trap - EXIT; disown -a; exit 0; fi
wait
