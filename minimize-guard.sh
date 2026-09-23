#!/usr/bin/env bash
# ── keep the worker's Chrome window minimised, and keep it that way ──────────
#
# The browser must stay HEADED (headless gets the account signed out and is a
# fingerprint tell), but it must never be seen. A one-shot minimise is not enough:
# Chrome re-raises its own window on its own schedule — creating a tab, a send, a
# page taking focus — so the window reappears mid-task even though nothing asked it
# to. Measured phrasing: "everytime a message is sent it pops up but instantly
# minimized… ensure it stays perma minimized".
#
# ── WHY THE INTERVAL IS 0.15s AND NOT 2s ────────────────────────────────────
# This was a 2-second poll. Re-minimising within 2s of a raise still leaves the
# window on screen for up to two seconds, which reads as a flash on every send —
# the guard was working and the requirement was still not met. Reaction time IS the
# feature. 0.15s is below the threshold where a raise becomes perceptible.
#
# Cost is kept off a hot loop on purpose: the Chrome pid is resolved ONCE and only
# re-resolved when it dies, so the steady state is a single `xdotool search` per tick
# rather than a pgrep + search pair. `--onlyvisible` returns only windows actually on
# screen, so an already-minimised window is simply absent and every hit is a real
# raise — no state to guess, and nothing to do in the common case.
#
# Usage:  minimize-guard.sh <chrome-profile-dir> [interval-seconds]
# Stop:   kill "$(cat <profile-parent>/minimize-guard.pid)"
set -u

PROFILE="${1:-}"
INTERVAL="${2:-0.15}"
[ -n "$PROFILE" ] || { echo "usage: minimize-guard.sh <chrome-profile-dir> [interval]" >&2; exit 2; }

export DISPLAY="${WEBCHAT_DISPLAY:-:0}"
PIDFILE="$(dirname "$PROFILE")/minimize-guard.pid"

# Single-instance: a second guard is just a second poller fighting the same window,
# and that is how three of them accumulated. Take over the slot instead of stacking.
if [ -f "$PIDFILE" ]; then
    old="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [ -n "$old" ] && [ "$old" != "$$" ] && kill -0 "$old" 2>/dev/null; then
        kill "$old" 2>/dev/null || true
        sleep 0.2
    fi
fi
echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE"; exit 0' TERM INT

command -v xdotool >/dev/null 2>&1 || {
    echo "minimize-guard: xdotool not found — cannot hide the window" >&2
    rm -f "$PIDFILE"; exit 1
}

pid=""
while true; do
    # Resolve the Chrome pid once; only look again when it is gone. A pgrep per tick
    # would double the process churn for a value that never changes in practice.
    if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
        pid="$(pgrep -f "user-data-dir=$PROFILE" 2>/dev/null | head -1)"
        if [ -z "$pid" ]; then
            rm -f "$PIDFILE"          # Chrome is gone; nothing left to guard
            exit 0
        fi
    fi
    for w in $(xdotool search --onlyvisible --pid "$pid" 2>/dev/null); do
        xdotool windowminimize "$w" 2>/dev/null
    done
    sleep "$INTERVAL"
done
