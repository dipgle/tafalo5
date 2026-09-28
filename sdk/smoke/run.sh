#!/usr/bin/env bash
# Build the SDK and run the end-to-end smoke against a running server.
#
#   TFL5_SMOKE_HOST=http://localhost:8090 \
#   TFL5_SMOKE_VERIFY_CMD='<command that marks user {user} email-verified>' \
#   smoke/run.sh
#
# New accounts must verify their email before they can create an app. The
# smoke registers throwaway users, so it needs a way to mark them verified on
# a test server: TFL5_SMOKE_VERIFY_CMD is run with {user} replaced by the
# username. Without it the smoke stops at the first write.
#
# Exit codes are the smoke's own: 0 passed · 1 failed · 2 crashed ·
# 3 passed but some steps could not be measured on this server.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${TFL5_SMOKE_HOST:=http://localhost:8090}"
export TFL5_SMOKE_HOST

echo "==> build"
npm run build --silent

echo "==> smoke against ${TFL5_SMOKE_HOST}"
exec node smoke/smoke.mjs
