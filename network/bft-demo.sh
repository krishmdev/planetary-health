#!/usr/bin/env bash
# Orderer fault demo on the running network; writes docs/bft-demo.md.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm -C experiments bft-demo
