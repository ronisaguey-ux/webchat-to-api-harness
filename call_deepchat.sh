#!/usr/bin/env bash
# call_deepchat.sh — operator → deepseek-brain channel (the reverse of call_main).
# Pushes a message into the pinned deepseek webchat thread via the gateway.
#
# Usage:
#   call_deepchat.sh "message"          # conversational — brain replies in prose
#   call_deepchat.sh -a "continue"      # autonomous — brain resumes the tool loop
#   call_deepchat.sh -a "..." -- -p /tmp/x.json   # optional: custom payload file
set -euo pipefail

# Resolve the gateway checkout from this script's own location, so the harness
# works from any clone path instead of one hard-coded machine.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load secure environment if available
ENV_FILE="${CALL_DEEPCHAT_ENV:-$SCRIPT_DIR/.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

AUTONOMOUS=0
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -a|-A|--autonomous) AUTONOMOUS=1; shift ;;
    --) shift; ARGS+=("$@"); break ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
TEXT="${ARGS[*]:-}"
[ -z "$TEXT" ] && { echo "usage: call_deepchat.sh [-a] \"message\"" >&2; exit 1; }
GATEWAY="${CALL_DEEPCHAT_URL:-http://127.0.0.1:8080/v1/chat/completions}"
# Read API token from secure file if not set in environment
if [ -z "${API_TOKEN:-}" ] && [ -f "${HOME}/.deepchat_token" ]; then
  API_TOKEN=$(cat "${HOME}/.deepchat_token" 2>/dev/null || echo "")
fi
# Mask token in any debug output
API_TOKEN_MASKED="${API_TOKEN:0:4}...${API_TOKEN: -4}"

python3 - "$GATEWAY" "$TEXT" "$AUTONOMOUS" << 'PYEOF' > /tmp/call_deepchat_payload.json
import json, sys
text = sys.argv[2]
body = {
    'model': 'deepseek webchat',
    'messages': [{'role': 'user', 'content': '### OPERATOR (main Claude session):\n' + text}],
    'stream': False,
}
if sys.argv[3] == '1':
    body['autonomous'] = True
json.dump(body, open('/tmp/call_deepchat_payload.json', 'w'))
PYEOF
echo "→ calling brain (autonomous=$AUTONOMOUS): ${TEXT:0:120}"
AUTH_HEADER=()
if [ -n "$API_TOKEN" ]; then
  AUTH_HEADER=(-H "Authorization: Bearer $API_TOKEN")
fi
curl -s -X POST "$GATEWAY" -H 'Content-Type: application/json' "${AUTH_HEADER[@]}" -d @/tmp/call_deepchat_payload.json --max-time 600 -o /tmp/call_deepchat_reply.json
echo "← reply: $(python3 -c "import json;print(json.load(open('/tmp/call_deepchat_reply.json')).get('choices',[{}])[0].get('message',{}).get('content','')[:400] if 1 else '')" 2>/dev/null || head -c 300 /tmp/call_deepchat_reply.json)"
