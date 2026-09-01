#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADDR="${SESSION_INSIGHT_ADDR:-127.0.0.1:4788}"

echo "==> Building session insight frontend..."
pnpm --filter @session-insight/app build

SERVER_ARGS=(
  --web ../apps/session-insight/dist
  --addr "$ADDR"
)
if [ -n "${SESSION_INSIGHT_DATA:-}" ]; then
  SERVER_ARGS+=(--data "$SESSION_INSIGHT_DATA")
fi

cd "$ROOT/server"
echo "==> Starting session insight at http://$ADDR"
echo "    Press Ctrl-C to stop."

server_pid=""
forward_signal() {
  local signal="$1"
  if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
    kill "-$signal" "$server_pid" 2>/dev/null || true
  fi
}

cleanup() {
  local status="$?"
  trap - EXIT INT TERM
  forward_signal TERM
  if [ -n "$server_pid" ]; then
    wait "$server_pid" 2>/dev/null || true
  fi
  exit "$status"
}

trap 'forward_signal INT' INT
trap 'forward_signal TERM' TERM
trap cleanup EXIT

GOTOOLCHAIN=auto go run ./cmd/session-insight "${SERVER_ARGS[@]}" &
server_pid="$!"

set +e
wait "$server_pid"
status="$?"
set -e
exit "$status"
