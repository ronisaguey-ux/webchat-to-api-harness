#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  setup.sh — get this gateway running for ONE webchat, with no editing.
#
#  Before this existed, setup meant: copy chat.js.example → chat.js, find your
#  tab's URL, decide between attaching to a running browser and launching a new
#  one, hand-edit a JSON config that is gitignored, and guess a port. Every one
#  of those is a place to get stuck.
#
#  Now:  ./scripts/setup.sh
#
#  It asks at most three questions, is safe to re-run, and never overwrites an
#  existing .env without saying so. Everything it writes lives in .env, which is
#  gitignored — so a re-run is always recoverable.
#
#  Non-interactive (CI, scripts, or if you already know what you want):
#      ./scripts/setup.sh --chat gemini --port 8080 --yes
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

CHAT=""; PORT=""; ASSUME_YES=0; ATTACH=""

usage() {
  cat <<'U'
Usage: ./scripts/setup.sh [options]

  --chat <name>    webchat to drive: gemini | chatgpt | deepseek | kimi |
                   notegpt | freebuff | generic
  --port <n>       port for the gateway (default 8080)
  --attach <ws>    CDP websocket of an ALREADY-OPEN browser, e.g.
                   ws://127.0.0.1:9222/devtools/browser/…
  --yes            accept defaults, ask nothing
  -h, --help       this text
U
}

while [ $# -gt 0 ]; do
  case "$1" in
    --chat)   CHAT="${2:-}"; shift 2 ;;
    --port)   PORT="${2:-}"; shift 2 ;;
    --attach) ATTACH="${2:-}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

say() { printf '  %s\n' "$*"; }
hr()  { printf '  ────────────────────────────────────────────────────────\n'; }

# ── what can we drive? ───────────────────────────────────────────────────────
# The keys here are the mode names the server itself knows (see webchatModes in
# harness.config.json). Offering anything else would write a mode the server
# falls back to "generic" for, silently losing that site's selectors.
declare -A URL_OF=(
  [gemini]="https://gemini.google.com/app"
  [chatgpt]="https://chatgpt.com"
  [deepseek]="https://chat.deepseek.com"
  [kimi]="https://kimi.ai"
  [notegpt]="https://notegpt.io"
  [freebuff]="https://freebuff.com"
  [generic]=""
)
CHATS=(gemini chatgpt deepseek kimi notegpt freebuff generic)

hr
say "webchat-to-api harness — setup"
hr

# ── node check ───────────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  say "✗ node is required (>=20.12) but was not found on PATH."
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  say "✗ node $NODE_MAJOR is too old — puppeteer 25 needs >=20."
  exit 1
fi
say "✓ node $(node -v)"

# ── dependencies ─────────────────────────────────────────────────────────────
if [ ! -d node_modules ]; then
  say "· installing dependencies (first run only)…"
  npm install --no-audit --no-fund >/dev/null 2>&1 || {
    say "✗ npm install failed. Run it by hand to see why:  npm install"; exit 1; }
fi
say "✓ dependencies present"

# ── which chat ───────────────────────────────────────────────────────────────
if [ -z "$CHAT" ]; then
  if [ "$ASSUME_YES" = "1" ]; then
    CHAT=gemini
  else
    echo
    say "Which webchat should this drive?"
    n=1
    for c in "${CHATS[@]}"; do
      printf '    %d) %s\n' "$n" "$c"
      n=$((n+1))
    done
    printf '  Choose [1]: '
    read -r pick || true
    pick="${pick:-1}"
    CHAT="${CHATS[$((pick-1))]:-gemini}"
  fi
fi

if [ -z "${URL_OF[$CHAT]+x}" ]; then
  say "✗ unknown chat '$CHAT'. Known: ${CHATS[*]}"
  exit 2
fi
WEBCHAT_URL="${URL_OF[$CHAT]}"
if [ -z "$WEBCHAT_URL" ]; then
  echo
  printf '  Paste the full URL of your webchat tab: '
  read -r WEBCHAT_URL
  if [ -z "$WEBCHAT_URL" ]; then say "✗ a URL is required for 'generic'."; exit 2; fi
fi
say "✓ chat: $CHAT  ($WEBCHAT_URL)"

# ── port ─────────────────────────────────────────────────────────────────────
if [ -z "$PORT" ]; then
  # Pick a port that is actually free instead of defaulting into a collision —
  # a busy port is the single most common first-run failure.
  PORT=8080
  while command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":$PORT "; do
    PORT=$((PORT+1))
  done
fi
say "✓ port: $PORT"

# ── write .env ───────────────────────────────────────────────────────────────
if [ -f .env ]; then
  cp .env "env.bak-$(date +%Y%m%d-%H%M%S)"
  say "· existing .env backed up (env.bak-*)"
fi
cat > .env <<ENV
# Written by ./scripts/setup.sh on $(date '+%Y-%m-%d %H:%M'). Safe to edit by hand.
HOST=127.0.0.1
PORT=$PORT

# ── the webchat this gateway drives ─────────────────────────────────────────
WEBCHAT_MODE=$CHAT
MODEL_NAME=$CHAT-webchat
WEBCHAT_URL=$WEBCHAT_URL
HEADLESS=false
ENV

if [ -n "$ATTACH" ]; then
  cat >> .env <<ENV

# Attach to an already-open browser instead of launching one. Find this value at
# http://127.0.0.1:<debug-port>/json/version while that browser is running.
CDP_WS_URL=$ATTACH
ENV
  say "✓ will attach to an existing browser"
else
  cat >> .env <<'ENV'

# ── the browser ─────────────────────────────────────────────────────────────
# HEADLESS=false is deliberate: headless gets signed out by Google and is a
# fingerprint tell. The window opens minimised instead, so it stays out of the
# way while remaining a real, logged-in browser.
ENV
fi

# ── config + sandbox, only if the user wants a fence ─────────────────────────
cat >> .env <<'ENV'

# ── optional: keep the model inside a directory tree ────────────────────────
# Every file path the webchat model passes to a tool, and every path-like token
# in a bash command, must resolve inside one of these roots. Unset = unrestricted
# (the model may read anything your user can). Set it when you are pointing this
# at a specific project:
# SANDBOX_ROOTS=/path/to/your/project
# SANDBOX_ALLOW_BASH=true
ENV

hr
say "✓ wrote .env"
echo
say "Next, start it:"
echo
echo "      ./scripts/start.sh"
echo
say "The browser will open MINIMISED. To sign in for the first time:"
echo
echo "      ./scripts/launch-agent.sh any        # prints the env for your agent"
echo "      # or raise the window:       (see README → 'Signing in')"
echo
say "Then point any coding agent at it:"
echo
echo "      ./scripts/launch-agent.sh opencode   # or: claude, codex, aider, …"
echo
