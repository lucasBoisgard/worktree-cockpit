#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="$DIR/server.pid"
CONFIG="$DIR/cockpit.config.json"

config_value() {
  [ -f "$CONFIG" ] && sed -n "s/^[[:space:]]*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$CONFIG" | head -n 1
}

CONTAINER="$(config_value container)"
if [ -n "$CONTAINER" ] && [ ! -f /.dockerenv ]; then
  exec docker exec "$CONTAINER" "$DIR/start.sh"
fi

if ! command -v tmux >/dev/null; then
  echo "Installing tmux…"
  (apt-get install -y tmux >/dev/null 2>&1 || (apt-get update >/dev/null 2>&1 && apt-get install -y tmux >/dev/null 2>&1)) || echo "tmux install failed: sessions will be read-only"
fi

node "$DIR/install.js" || echo "install.js failed: hooks, status line, skills or token may be missing"

[ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null

DEFAULT_HOST=127.0.0.1
[ -f /.dockerenv ] && DEFAULT_HOST=0.0.0.0
HOST="${HOST:-${COCKPIT_LISTEN:-$DEFAULT_HOST}}" PORT="${PORT:-8052}" nohup node "$DIR/server.js" > "$DIR/server.log" 2>&1 &
echo $! > "$PIDFILE"
sleep 0.5
cat "$DIR/server.log"
echo "Open http://${MACHINE_HOSTNAME:-localhost}:${PORT:-8052}/?token=$(cat "$DIR/token")"
