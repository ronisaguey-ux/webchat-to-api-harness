#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  verify-launchers.sh — prove every launch-agent.sh recipe actually exports
#  what that agent needs, without needing any of the agents installed.
#
#  Each recipe is run against a STUB binary that echoes the environment it was
#  given and the arguments it was passed. That is the whole point: the recipe's
#  job is to set up an environment correctly, so the environment is what gets
#  asserted — a recipe can look right in the source and still export a variable
#  nobody reads.
#
#  Run it after editing launch-agent.sh:
#      ./harness_tests/verify-launchers.sh
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

STUB="$(mktemp -d)"
trap 'rm -rf "$STUB"' EXIT

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }
check(){ # name, haystack, needle
  if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else bad "$1" "missing: $3"; fi
}

# A stub for every agent the launcher knows, so the test never depends on what is
# installed on this machine.
for a in opencode claude codex aider hermes crush; do
  cat > "$STUB/$a" <<'STUBEOF'
#!/usr/bin/env bash
env | grep -E '^(OPENAI_BASE_URL|OPENAI_API_BASE|OPENAI_API_KEY|ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN|HARNESS_MODEL_NAME)=' | sort
printf 'ARGS:%s\n' "$*"
STUBEOF
  chmod +x "$STUB/$a"
done

# Point at a port nothing serves so the run cannot depend on a live gateway, and
# stand up the minimum /health shape the launcher parses. It reads the BODY, so
# any JSON carrying `ok` is accepted — that is the contract this test pins.
# A node one-liner rather than nc: nc's flags differ across distros and it is not
# always installed, which made this test fail for reasons unrelated to the recipes.
FAKE_PORT=$(( 18000 + RANDOM % 2000 ))
node -e '
  const http = require("http");
  const port = Number(process.argv[1]);
  http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, browserAlive: true, wedged: false, outstandingMs: 0 }));
  }).listen(port, "127.0.0.1");
' "$FAKE_PORT" &
SRV_PID=$!
trap 'kill $SRV_PID 2>/dev/null; rm -rf "$STUB"' EXIT
# Wait for it to bind, and FAIL LOUDLY if it does not: an unbound fake gateway
# makes every recipe look broken while the fault is in this test.
BOUND=0
for _ in $(seq 1 60); do
  if curl -s -m 1 "http://127.0.0.1:$FAKE_PORT/health" >/dev/null 2>&1; then BOUND=1; break; fi
  sleep 0.15
done
if [ "$BOUND" != "1" ]; then
  echo "  ✗ the fake gateway never bound on $FAKE_PORT — this test cannot run." >&2
  exit 3
fi

export PORT="$FAKE_PORT"
export HARNESS_MODEL_NAME="test-model"
export PATH="$STUB:$PATH"

run() { timeout 15 ./scripts/launch-agent.sh "$@" 2>/dev/null; }

echo "verify-launchers — every recipe, against stubs"

# ── any mode: the documented integration surface ────────────────────────────
OUT="$(run any)"
check "any: prints the base URL"   "$OUT" "127.0.0.1:$FAKE_PORT"
check "any: prints the model"      "$OUT" "test-model"
check "any: prints a curl example" "$OUT" "chat/completions"

# ── per-agent assertions ────────────────────────────────────────────────────
# Each entry: agent, then the strings that MUST appear in its captured env/args.
while IFS='|' read -r agent needs; do
  [ -z "$agent" ] && continue
  OUT="$(run "$agent")"
  if [ -z "$OUT" ]; then
    bad "$agent: produced no output" "the recipe exited before exec'ing the stub"
    continue
  fi
  IFS=',' read -ra REQS <<< "$needs"
  for req in "${REQS[@]}"; do
    # ${B} is expanded here, at run time — the table cannot know the port.
    req="${req//PORT/$FAKE_PORT}"
    check "$agent: $req" "$OUT" "$req"
  done
done <<TABLE
claude|ANTHROPIC_BASE_URL=http://127.0.0.1:PORT,ANTHROPIC_AUTH_TOKEN=
codex|OPENAI_BASE_URL=http://127.0.0.1:PORT/v1,OPENAI_API_KEY=
aider|--openai-api-base http://127.0.0.1:PORT/v1,--model openai/test-model
hermes|OPENAI_BASE_URL=http://127.0.0.1:PORT/v1
crush|OPENAI_BASE_URL=http://127.0.0.1:PORT/v1
TABLE

# ── an unknown agent must fail loudly, not silently do nothing ──────────────
OUT="$(timeout 15 ./scripts/launch-agent.sh notarealagent 2>&1)"; RC=$?
if [ "$RC" -ne 0 ]; then ok "unknown agent: non-zero exit ($RC)"
else bad "unknown agent: exited 0" "an unknown name must not look like success"; fi
check "unknown agent: says what IS known" "$OUT" "opencode"

# ── opencode writes a config instead of relying on an env var ───────────────
rm -f opencode.json
OUT="$(run opencode)"
if [ -f opencode.json ]; then
  ok "opencode: wrote opencode.json"
  if node -e 'const d=require("./opencode.json"); process.exit(d.model && d.provider && d.plugin ? 0 : 1)' 2>/dev/null; then
    ok "opencode: config has model, provider and plugin"
  else
    bad "opencode: config is missing required keys"
  fi
  # OPENCODE_CONFIG is a trap: it is read only by `opencode debug config`, not by
  # the runtime. The file must sit in the working directory.
  if grep -q '"plugin": \[\]' opencode.json; then
    ok "opencode: plugin array emptied (no agent-harness plugins in this lane)"
  else
    bad "opencode: plugin array not emptied"
  fi
  rm -f opencode.json
else
  bad "opencode: no opencode.json written"
fi

echo
printf 'verify-launchers: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
