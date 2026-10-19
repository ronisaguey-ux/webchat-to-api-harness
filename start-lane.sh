#!/usr/bin/env bash
# Start the local shannon webchat lane (owner's DS account, CDP :9223 → :8086).
# Chrome (dedicated profile gc-ds) must be logged into chat.deepseek.com once;
# cookies persist (SAVE_COOKIES).
set -e
cd "$(dirname "$0")"
if ! curl -sf --max-time 3 http://127.0.0.1:9223/json/version >/dev/null; then
  setsid nohup /opt/google/chrome/chrome --remote-debugging-port=9223 \
    --user-data-dir=/home/roni-saguey/.webchat/gc-ds \
    --no-first-run --no-default-browser-check --no-metrics-recording --disable-sync \
    https://chat.deepseek.com >/tmp/webchat-chrome.log 2>&1 &
  sleep 4
fi
# GIT_ROOT = repo the lane model's tools operate on (shannon scan target).
# helpotron scan defaults; T2B scan: GIT_ROOT=/home/roni/Roni_workspace/t2b bash start-lane.sh
export GIT_ROOT="${GIT_ROOT:-/home/roni/Roni_workspace/helpotron}"
# WS_SHANNON_DIR = host dir of the scan workspace .shannon (container path
# /repos/<repo>/.shannon overlays it). Set per scan, e.g.:
#   WS_SHANNON_DIR=/home/roni-saguey/.shannon/workspaces/<workspace>/.shannon
export WS_SHANNON_DIR="${WS_SHANNON_DIR:-/home/roni-saguey/.shannon/workspaces/t2b-helpotron-helpotron-260904-004543/.shannon}"
# 09-04: shannon lane is machine-to-machine — the drift_v2 gate (judge-on-
# escalation) fails its judge call and HELDS every final answer as
# [DRIFT-PAUSED], killing the run (AGENT_EXECUTION_FAILED). Lane must pass
# responses through: DRIFT_DETECT=0 (gate mode 0 = passthrough).
export DRIFT_DETECT="${DRIFT_DETECT:-0}"
# 09-04: one thread shared by every pi run degenerates the tab model (it
# stopped calling tools once the thread hit ~90-120k chars). pi re-sends the
# full context every request, so a fresh thread loses nothing — handoff to a
# brand-new chat once the thread body passes the threshold and keep it low.
export CONTEXT_HANDOFF_THRESHOLD="${CONTEXT_HANDOFF_THRESHOLD:-60000}"
# 09-04 (Bob, owner): instant mode WITHOUT DeepThink triggered the DS account
# cap — the lane must run EXPERT mode with DeepThink ON (FORCE_EXPERT swaps the
# tab to a fresh EXPERT chat; EXPERT_DEEPTHINK pins the DeepThink chip on), and
# after a cap storm wait 20 min before retrying (cooldown ceiling + boot hold).
export FORCE_EXPERT="${FORCE_EXPERT:-1}"
export EXPERT_DEEPTHINK="${EXPERT_DEEPTHINK:-1}"
export RATE_LIMIT_COOLDOWN_MAX_MS="${RATE_LIMIT_COOLDOWN_MAX_MS:-1200000}"
# boot hold: 0 by default (a routine restart is NOT a storm — 09-04 owner).
# Only storm restarts pass RATE_LIMIT_INITIAL_HOLD_MS=1200000 explicitly.
export RATE_LIMIT_INITIAL_HOLD_MS="${RATE_LIMIT_INITIAL_HOLD_MS:-0}"
# 09-04 (owner): every prompt send waits at least 20s since the last send —
# keeps the account under the webchat message cap (rate_limit_reached).
export MIN_SEND_INTERVAL_MS="${MIN_SEND_INTERVAL_MS:-20000}"
exec env HOST=0.0.0.0 PORT=8086 \
  CDP_WS_URL=ws://127.0.0.1:9223/devtools/browser/x \
  WEBCHAT_URL=https://chat.deepseek.com \
  TAB_URL_SUBSTRING=chat.deepseek.com \
  RESPONSES_BRIDGE=1 CHAT_COMPLETIONS_SSE=1 CALL_FIRST=1 JSON_TEXT_FALLBACK=1 \
  BASH_ALLOWED=1 \
  THINKING_HEAD_GUARD=1 SAVE_COOKIES=1 \
  node server.js
