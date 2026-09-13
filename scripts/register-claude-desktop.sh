#!/bin/bash
# Registers this MCP server in Claude Desktop's claude_desktop_config.json.
#
# Claude Desktop keeps that file in memory and rewrites it while it's running, so edits
# made with the app open get silently lost. This script waits until the app has quit,
# writes the entry, and reopens the app.
#
# Usage (from a terminal that is NOT inside Claude Desktop, e.g. Terminal.app):
#   ./scripts/register-claude-desktop.sh      # then quit Claude Desktop with Cmd+Q
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
NAME="${MCP_NAME:-openai-images}"
NODE="${NODE_BIN:-$(command -v node || true)}"
APP_PATTERN='/Applications/Claude.app/Contents/MacOS/Claude$'
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-1800}"

[ -x "$NODE" ] || { echo "node not found; set NODE_BIN=/path/to/node"; exit 1; }
# MCP_ENTRY lets the script run from outside the repo (e.g. launchd can't read ~/Documents).
ENTRY="${MCP_ENTRY:-$ROOT/dist/index.js}"
[ -n "${MCP_ENTRY:-}" ] || [ -f "$ENTRY" ] || { echo "dist/index.js missing; run npm run build first"; exit 1; }

reopen=0
if pgrep -f "$APP_PATTERN" >/dev/null; then
  echo "$(date '+%F %T') Waiting for Claude Desktop to quit (Cmd+Q)…"
  waited=0
  while pgrep -f "$APP_PATTERN" >/dev/null; do
    sleep 1
    waited=$((waited + 1))
    if [ "$waited" -ge "$TIMEOUT_SECONDS" ]; then
      echo "$(date '+%F %T') Claude Desktop didn't quit within ${TIMEOUT_SECONDS}s; nothing changed."
      exit 1
    fi
  done
  sleep 2 # let the app finish shutting down
  reopen=1
fi

mkdir -p "$(dirname "$CFG")"
[ -f "$CFG" ] || echo '{}' >"$CFG"
cp "$CFG" "$CFG.bak-$(date +%Y%m%d%H%M%S)"

"$NODE" -e '
const fs = require("fs");
const [cfg, name, node, entry] = process.argv.slice(1);
const j = JSON.parse(fs.readFileSync(cfg, "utf8"));
j.mcpServers = j.mcpServers || {};
j.mcpServers[name] = { command: node, args: [entry] };
fs.writeFileSync(cfg, JSON.stringify(j, null, 2));
console.log("Registered MCP servers:", Object.keys(j.mcpServers).join(", "));
' "$CFG" "$NAME" "$NODE" "$ENTRY"

echo "$(date '+%F %T') '$NAME' registered in Claude Desktop."
if [ "$reopen" -eq 1 ]; then
  open -a Claude
  echo "$(date '+%F %T') Claude Desktop reopened."
fi
