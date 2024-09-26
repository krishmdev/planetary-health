#!/usr/bin/env bash
# Unattended network session: bring the network up, run the given phases, write results, and
# always tear down. Meant to be the single command under a shared compute lease, e.g.
#   compute_lease.py run planetary-fabric -- scripts/lease-run.sh e2e bft throughput faults
# Phases: e2e bft throughput faults app coldstart screenshots idle
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
[ -f .env ] || cp .env.example .env
set -a; source .env; set +a
export HOST_UID="$(id -u)" HOST_GID="$(id -g)" NODE_OPTIONS=--no-warnings
mkdir -p .data/logs
log=".data/logs/lease-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$log") 2>&1

cleanup() {
  pkill -f 'tsx src/server.ts' 2>/dev/null
  network/down.sh > .data/logs/down.log 2>&1
  echo "[lease-run] torn down"
}
trap cleanup EXIT

status=0
run() {
  echo "[lease-run] $(date +%T) phase $1"
  shift
  "$@" || { echo "[lease-run] phase failed: $*"; status=1; }
}

network/all-up.sh > .data/logs/all-up.log 2>&1 || { echo "[lease-run] network bring-up failed"; tail -30 .data/logs/all-up.log; exit 1; }
echo "[lease-run] $(date +%T) network up"

for phase in "$@"; do
  case "$phase" in
    e2e)
      scripts/gateways-host.sh --detach
      run e2e pnpm -C gateway e2e
      pkill -f 'tsx src/server.ts'
      ;;
    bft) run bft pnpm -C experiments bft-demo ;;
    throughput) run throughput pnpm -C experiments throughput --duration "${E2_DURATION:-45}" ;;
    faults) run faults pnpm -C experiments faults ;;
    app)
      run app-build docker compose -f compose.app.yaml --env-file .env build
      run app-up bash -c 'docker compose -f compose.app.yaml --env-file .env up -d activator ui && docker compose -f compose.app.yaml --env-file .env create org1-api org2-api'
      ;;
    coldstart) run coldstart pnpm -C experiments coldstart --n "${E1_N:-20}" --n-full "${E1_N_FULL:-${E1_N:-20}}" ;;
    screenshots) run screenshots node ui/scripts/screenshots.mjs http://localhost:8088 ;;
    idle) run idle pnpm -C experiments idle --window "${E4_WINDOW:-600}" --repeats "${E4_REPEATS:-3}" ;;
    *) echo "[lease-run] unknown phase $phase"; status=1 ;;
  esac
done
docker compose -f compose.app.yaml --env-file .env logs --no-color > .data/logs/app.log 2>&1 || true
exit $status
