#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
log() { echo "[$(ts)] $*"; }

log "sync before agents run"
bun run src/cli.ts sync

log "running all enabled agents"
bun run src/cli.ts agents run --all
log "done"
