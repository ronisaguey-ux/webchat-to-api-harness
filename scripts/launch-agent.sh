#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  launch-agent.sh — point any coding agent at whatever webchat tab this
#  gateway is driving.
#
#  The agent launches NORMALLY. This script does not proxy the agent, does not
#  fork it, and does not wrap its traffic. All it does is export the base URL
#  and model name that the agent's own provider config already expects, then
#  exec the agent.
#
#  Usage:
#      ./scripts/launch-agent.sh <agent> [-- <extra agent args>]
#
#  Agents:  opencode | claude | codex | aider | hermes | crush | any
#
#  Examples:
#      ./scripts/launch-agent.sh opencode
#      ./scripts/launch-agent.sh claude
#      ./scripts/launch-agent.sh aider -- --model whatever
#      ./scripts/launch-agent.sh any            # just print the env, launch nothing
#
#  If your agent is not in the table below, run `./scripts/launch-agent.sh any` and read
#  the printed variables — they are the entire integration surface. Any tool that
#  lets you set an OpenAI-compatible base URL will work with them.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE/.."

# ── resolve the gateway ──────────────────────────────────────────────────────
# PORT may come from the environment; otherwise read it out of .env so this
# script agrees with the running server instead of assuming 8080.
if [ -z "${PORT:-}" ] && [ -f .env ]; then
  PORT="$(grep -E '^PORT=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' ' || true)"
fi
PORT="${PORT:-8080}"
BASE="${HARNESS_BASE_URL:-http://127.0.0.1:$PORT}"

# The model name the gateway advertises. This is the id the agent must send, and
# it comes from the same config the server reads — so a rename in one place does
# not silently desync the two.
MODEL="${HARNESS_MODEL:-${HARNESS_MODEL_NAME:-}}"
# HARNESS_MODEL_NAME is accepted as an INPUT as well as exported as an output:
# it is the variable users see in the docs, so silently ignoring it as an
# override would be a dead end that looks like the config being ignored.
if [ -z "$MODEL" ]; then
  MODEL="$(
    HARNESS_CONFIG="${HARNESS_CONFIG:-$HERE/harness.config.json}" node -e '
      try { const c = require("./config"); process.stdout.write(c.modelName || ""); }
      catch { process.stdout.write(""); }
    ' 2>/dev/null || true
  )"
fi
MODEL="${MODEL:-deepseek webchat}"

# A key is only needed if API_TOKEN was set on the server. Harmless otherwise:
# a gateway with no API_TOKEN ignores the header.
KEY="${HARNESS_API_KEY:-${API_TOKEN:-webchat-local}}"

# ── is it up? ────────────────────────────────────────────────────────────────
# Read the BODY, not the status code. /health answers 503 whenever the browser is
# not attached yet, and 503 still means "the gateway is up and will attach on the
# first request" — using `curl -f` here refused to launch an agent against a
# perfectly healthy server that had simply not opened its tab yet.
HEALTH="$(curl -s -m 4 "$BASE/health" 2>/dev/null || true)"
case "$HEALTH" in
  *'"ok"'*|*'browserAlive'*|*'wedged'*) : ;;   # up (attached or not)
  *)
  cat >&2 <<MSG

  ⚠️  No gateway answering at $BASE

  Start it first, from the repo root:

      ./scripts/start.sh                     # or: npm start

  Then, in another terminal, point your agent at it with this script.

MSG
  exit 1
  ;;
esac

# ── the one integration surface ──────────────────────────────────────────────
# These four variables are all a client needs. Print them in `any` mode and for
# any agent this script does not know, so a new tool is a config edit rather
# than a code change.
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-$BASE/v1}"
export OPENAI_API_BASE="${OPENAI_API_BASE:-$BASE/v1}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-$KEY}"
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-$BASE}"
export ANTHROPIC_AUTH_TOKEN="${ANTHROPIC_AUTH_TOKEN:-$KEY}"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-$KEY}"
# Exported so the help text, the curl example and the opencode config writer all
# refer to the same resolved name instead of each guessing.
export HARNESS_MODEL_NAME="$MODEL"
export HARNESS_BASE_URL="$BASE"

AGENT="${1:-}"; shift || true
[ "${1:-}" = "--" ] && shift || true

banner() {
  cat >&2 <<MSG

  ┌──────────────────────────────────────────────────────────────┐
  │  webchat-as-an-API  →  $AGENT
  └──────────────────────────────────────────────────────────────┘
    base    : $BASE
    openai  : $BASE/v1
    model   : $MODEL
    key     : ${KEY:0:8}…

  The webchat tab is the model. Every reply you see comes from it.
MSG
}

case "$AGENT" in
  opencode)
    banner
    cat >&2 <<MSG
    opencode reads provider config from a JSON file. This script has already
    written one at ./opencode.json for you — it is gitignored. Run opencode
    from THIS directory so it picks that file up.

MSG
    # opencode auto-discovers ./opencode.json from the working directory. The
    # OPENCODE_CONFIG env var is NOT equivalent (it is only read by
    # `opencode debug config`) — the file must sit where you run the agent.
    node -e '
      const fs = require("fs");
      const cfg = {
        "$schema": "https://opencode.ai/config.json",
        provider: {
          webchat: {
            npm: "@ai-sdk/openai-compatible",
            name: "Webchat harness",
            options: { baseURL: process.env.OPENAI_BASE_URL },
            models: { [process.env.HARNESS_MODEL_NAME]: { name: process.env.HARNESS_MODEL_NAME } }
          }
        },
        model: "webchat/" + process.env.HARNESS_MODEL_NAME,
        // An agent harness is a DIFFERENT product from this gateway; its own
        // plugins and permissions must not leak into the webchat lane.
        plugin: []
      };
      fs.writeFileSync("opencode.json", JSON.stringify(cfg, null, 2));
    ' HARNESS_MODEL_NAME="$MODEL" 2>/dev/null || true
    exec opencode "$@"
    ;;

  claude)
    banner
    cat >&2 <<MSG
    Claude Code talks to ANTHROPIC_BASE_URL. The gateway implements
    /v1/messages, so this works without any config file — the env vars above
    are the whole setup.

MSG
    exec claude "$@"
    ;;

  codex)
    banner
    cat >&2 <<MSG
    Codex reads OPENAI_BASE_URL for an OpenAI-compatible endpoint. If it insists
    on its own config, write this once:

        model_provider = "webchat"
        [model_providers.webchat]
        base_url = "$BASE/v1"
        env_key  = "OPENAI_API_KEY"

MSG
    exec codex "$@"
    ;;

  aider)
    banner
    # aider names the endpoint explicitly rather than reading OPENAI_BASE_URL.
    exec aider --openai-api-base "$BASE/v1" --openai-api-key "$KEY" \
               --model "openai/$MODEL" "$@"
    ;;

  hermes)
    banner
    # Hermes is configured through its own model settings; these variables are
    # what it needs. Export them and run it.
    exec hermes "$@"
    ;;

  crush)
    banner
    exec crush "$@"
    ;;

  any|"")
    banner
    # STDOUT, not stderr: this is the primary output of this mode, so it must be
    # capturable (`./scripts/launch-agent.sh any > vars.txt`) and pipeable.
    cat <<MSG
OPENAI_BASE_URL=$OPENAI_BASE_URL
OPENAI_API_BASE=$OPENAI_API_BASE
OPENAI_API_KEY=$OPENAI_API_KEY
ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL
ANTHROPIC_AUTH_TOKEN=$ANTHROPIC_AUTH_TOKEN
HARNESS_MODEL_NAME=$HARNESS_MODEL_NAME

# nothing was launched — this is the whole integration surface.
# point any OpenAI-compatible tool at OPENAI_BASE_URL and use the model above.
#
# curl check:
curl -s "$OPENAI_BASE_URL/chat/completions" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"'"$HARNESS_MODEL_NAME"'","messages":[{"role":"user","content":"hi"}]}'
MSG
    ;;

  *)
    echo "  unknown agent '$AGENT' — known: opencode claude codex aider hermes crush any" >&2
    echo "  run: $0 any   (prints the env you need for anything else)" >&2
    exit 2
    ;;
esac
