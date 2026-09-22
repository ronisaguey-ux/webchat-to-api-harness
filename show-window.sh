#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  show-window.sh — raise or drop the harness browser window.
#
#  The browser runs HEADED but MINIMISED, on purpose: a real headed browser keeps
#  your login (headless gets signed out and is a fingerprint tell), while staying
#  out of your way. Chrome re-raises its own window whenever a page takes focus —
#  typing a message, opening a chat — so a single minimise does not hold. A guard
#  re-asserts it every couple of seconds.
#
#      ./show-window.sh raise     # suspend the guard and bring the window up
#      ./show-window.sh drop      # minimise and restart the guard
#      ./show-window.sh status    # is it up, down, or is the guard running?
#
#  Typical first-run:   ./start.sh   then   ./show-window.sh raise
#                       … sign in …
#                       ./show-window.sh drop
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

ACTION="${1:-status}"

# Where this worker keeps its profile and pid. Defaults match `webchat`, so the
# standalone script and the driver act on the same browser.
WORKER="${WEBCHAT_WORKER:-$(dirname "$HERE")}"
PROFILE="${WEBCHAT_PROFILE:-$WORKER/chrome-profile}"
export DISPLAY="${WEBCHAT_DISPLAY:-:0}"

guard_pidfile() { printf '%s/minimize-guard.pid' "$WORKER"; }

profile_pid() {
  pgrep -f "user-data-dir=$PROFILE" 2>/dev/null | head -1 || true
}

require_tools() {
  command -v xdotool >/dev/null 2>&1 || {
    echo "  ✗ xdotool not found — install it (apt: xdotool) to control the window." >&2
    exit 1
  }
}

guard_stop() {
  local f; f="$(guard_pidfile)"
  [ -f "$f" ] && { kill "$(cat "$f" 2>/dev/null)" 2>/dev/null || true; rm -f "$f"; }
  for g in $(pgrep -f "minimize-guard" 2>/dev/null); do kill "$g" 2>/dev/null || true; done
  return 0
}

guard_start() {
  local script="$WORKER/minimize-guard.sh"
  if [ -x "$script" ]; then
    setsid --fork "$script" "$PROFILE" 2 >"$WORKER/state/minimize-guard.log" 2>&1 </dev/null &
    echo "  guard restarted (re-asserts the minimise)"
  else
    echo "  (no minimize-guard.sh next to the profile — the window may drift back up on its own)"
  fi
}

case "$ACTION" in
  raise)
    require_tools
    pid="$(profile_pid)"
    [ -n "$pid" ] || { echo "  ✗ the browser is not running. Start it: ./start.sh" >&2; exit 1; }
    guard_stop
    for w in $(xdotool search --pid "$pid" 2>/dev/null); do
      xdotool windowmap "$w" 2>/dev/null || true
    done
    # --sync so the window is actually focused before we return, otherwise the
    # first keystroke lands nowhere and it looks like the raise failed.
    for w in $(xdotool search --pid "$pid" 2>/dev/null); do
      xdotool windowactivate --sync "$w" 2>/dev/null || true
    done
    echo "  raised — sign in, then: ./show-window.sh drop"
    ;;

  drop)
    require_tools
    pid="$(profile_pid)"
    [ -n "$pid" ] || { echo "  ✗ the browser is not running." >&2; exit 1; }
    for w in $(xdotool search --onlyvisible --pid "$pid" 2>/dev/null); do
      xdotool windowminimize "$w" 2>/dev/null || true
    done
    guard_start
    echo "  dropped — the window stays out of your way"
    ;;

  status)
    pid="$(profile_pid)"
    if [ -z "$pid" ]; then
      echo "  browser : not running"
    else
      vis="$(command -v xdotool >/dev/null 2>&1 \
             && xdotool search --onlyvisible --pid "$pid" 2>/dev/null | wc -l || echo '?')"
      echo "  browser : running (pid $pid)"
      echo "  window  : $([ "${vis:-0}" -gt 0 ] 2>/dev/null && echo 'VISIBLE' || echo 'minimised')"
    fi
    f="$(guard_pidfile)"
    if [ -f "$f" ] && kill -0 "$(cat "$f" 2>/dev/null)" 2>/dev/null; then
      echo "  guard   : running (pid $(cat "$f"))"
    else
      echo "  guard   : not running"
    fi
    ;;

  *)
    echo "usage: $0 {raise|drop|status}" >&2
    exit 2 ;;
esac
