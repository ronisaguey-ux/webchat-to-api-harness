#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  show-window.sh — raise, minimise or query the harness browser window.
#
#  This is a thin wrapper around window.js, which drives Chrome over CDP. Use
#  this one if you prefer a shell entry point; both do exactly the same thing.
#
#      ./show-window.sh raise      # bring the window up (use this to sign in)
#      ./show-window.sh drop       # minimise it — and it STAYS minimised
#      ./show-window.sh maximize   # maximise it — and it STAYS maximised
#      ./show-window.sh status     # what state is it in?
#
#  NO GUARD. There used to be a `minimize-guard.sh` re-minimising every 0.15s and
#  it has been REMOVED. It could never stop the flash, because it was racing Chrome
#  instead of fixing the cause: new pages were created with background:false, which
#  activates the tab, which makes Chrome restore and raise the window. That is fixed
#  in browser.js (safeNewPage). Nothing raises the window now, so whatever you do to
#  it sticks — and the guard also used to fight YOU when you wanted it up.
#
#  Works on Linux, macOS and Windows (CDP, not xdotool).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

ACTION="${1:-status}"

if ! command -v node >/dev/null 2>&1; then
  echo "  ✗ node not found — the harness needs Node 18+." >&2
  exit 1
fi

case "$ACTION" in
  raise|show|up|open|normal|drop|hide|down|minimize|minimized|maximize|maximized|status) ;;
  *)
    echo "usage: $0 {raise|drop|maximize|status}" >&2
    exit 2 ;;
esac

exec node "$HERE/window.js" "$ACTION"
