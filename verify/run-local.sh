#!/usr/bin/env bash
#
# One-command local pre-push check.
#
# Boots the backend LOCALLY in demo mode (Node serving frontend + /api on
# http://localhost:3000), waits for it, runs the Playwright smoke + drilldown
# checks against it, then tears the backend down. Exit 0 = safe to push.
#
#   ./verify/run-local.sh           (or:  cd verify && npm run local)
#
# Requires: backend/.env.local (copy from backend/.env.local.example) and that
# `npm install` has been run in both backend/ and verify/.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_LOCAL="$ROOT/backend/.env.local"
LOG="$(mktemp -t caffrey-local.XXXXXX.log)"

# Playwright 1.60 doesn't recognise newer Ubuntu (e.g. 26.04 / this WSL host) and
# refuses to find the browser. The 24.04 build is binary-compatible, so on Linux
# default the host-platform override when the caller hasn't set their own.
# (No effect on macOS/other; export your own value to override.)
if [ "$(uname -s)" = "Linux" ]; then
  export PLAYWRIGHT_HOST_PLATFORM_OVERRIDE="${PLAYWRIGHT_HOST_PLATFORM_OVERRIDE:-ubuntu24.04-x64}"
fi

if [ ! -f "$ENV_LOCAL" ]; then
  echo "✗ Missing $ENV_LOCAL" >&2
  echo "  Create it:  cp backend/.env.local.example backend/.env.local" >&2
  exit 1
fi

# Seed the runtime config JSONs from their committed *.example.json templates.
# These hold commercial data on the box and are gitignored, so a fresh checkout
# has only the examples — fine for a local demo run.
for cfg in top-clients hypercare categories; do
  live="$ROOT/backend/config/$cfg.json"
  example="$ROOT/backend/config/$cfg.example.json"
  if [ ! -f "$live" ] && [ -f "$example" ]; then
    cp "$example" "$live"
    echo "→ seeded backend/config/$cfg.json from example"
  fi
done

echo "→ starting backend (demo mode) … log: $LOG"
( cd "$ROOT/backend" && exec node -r dotenv/config server.js dotenv_config_path=.env.local ) \
  >"$LOG" 2>&1 &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "→ waiting for http://127.0.0.1:3000 …"
ready=
for _ in $(seq 1 40); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "✗ backend exited during startup. Log:" >&2; cat "$LOG" >&2; exit 1
  fi
  if curl -sf http://127.0.0.1:3000/api/auth/status >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.5
done
if [ -z "$ready" ]; then
  echo "✗ backend did not become ready. Log:" >&2; cat "$LOG" >&2; exit 1
fi
echo "✓ backend up"

export VERIFY_BASE_URL="http://localhost:3000"
export VERIFY_ENV_PATH="$ENV_LOCAL"

cd "$ROOT/verify"
echo "→ smoke-overview"
node smoke-overview.js
echo "→ verify-drilldowns"
node verify-drilldowns.js

echo "✓ all local checks passed — safe to push"
