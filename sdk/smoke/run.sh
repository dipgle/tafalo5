#!/usr/bin/env bash
# Build the SDK and run the e2e smoke test against a local dev server.
#
#   sdk/smoke/run.sh                      # host=http://localhost:8090, pg=tfl5_pg
#   TFL5_SMOKE_HOST=... PG_CONTAINER=... sdk/smoke/run.sh
#
# Prereqs: dev server running (a local tfl5 instance on :8090) + the dev
# Postgres container reachable for the email-verify test fixture.
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="${TFL5_SMOKE_HOST:-http://localhost:8090}"
PG_CONTAINER="${PG_CONTAINER:-tfl5_pg}"

echo "==> build SDK"
npx --yes -p typescript@5.4 tsc -p tsconfig.json

echo "==> smoke against ${HOST} (pg fixture: ${PG_CONTAINER})"
TFL5_SMOKE_HOST="$HOST" \
TFL5_SMOKE_VERIFY_CMD="docker exec ${PG_CONTAINER} psql -U tfl5 -d tfl5 -c \"UPDATE users SET email_verified=TRUE WHERE username='{user}'\"" \
  node smoke/smoke.mjs
