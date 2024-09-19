#!/usr/bin/env bash
# Bring the network up, run the e2e against host gateways, then tear down (KEEP=1 keeps it).
# Meant to run under the shared compute lease.
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
[ -f .env ] || cp .env.example .env
if [ "${SKIP_UP:-0}" != "1" ]; then network/all-up.sh || { [ "${KEEP:-0}" = 1 ] || network/down.sh; exit 1; }; fi
scripts/gateways-host.sh --detach
set -a; source .env; set +a
pnpm -C gateway e2e; rc=$?
pkill -f 'tsx src/server.ts' || true
[ "${KEEP:-0}" = "1" ] || network/down.sh
exit $rc
