#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"

if grep -q '"container"[[:space:]]*:[[:space:]]*"[^"]' "$DIR/cockpit.config.json" 2>/dev/null && [ ! -f /.dockerenv ]; then
  exit 0
fi

PID="$(cat "$DIR/server.pid" 2>/dev/null)"
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  exit 0
fi

nohup "$DIR/start.sh" > /dev/null 2>&1 &
exit 0
