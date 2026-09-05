#!/usr/bin/env bash
# call_deepchat.sh — operator → deepseek-brain channel (the reverse of call_main).
# Pushes a message into the pinned deepseek webchat thread via the gateway.
#
# Usage:
#   call_deepchat.sh "message"          # conversational — brain replies in prose
#   call_deepchat.sh -a "continue"      # autonomous — brain resumes the tool loop
#   call_deepchat.sh -a "..." -- -p /tmp/x.json   # optional: custom payload file
set -euo pipefail
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

python3 - "$GATEWAY" "$TEXT" "$AUTONOMOUS" << 'PYEOF' > /tmp/call_deepchat_payload.json
import json, sys
sys.path.insert(0, '/home/roni/Roni_Workspace/webchat-api')
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
curl -s -X POST "$GATEWAY" -H 'Content-Type: application/json' -d @/tmp/call_deepchat_payload.json --max-time 600 -o /tmp/call_deepchat_reply.json
echo "← reply: $(python3 -c "import json;print(json.load(open('/tmp/call_deepchat_reply.json')).get('choices',[{}])[0].get('message',{}).get('content','')[:400] if 1 else '')" 2>/dev/null || head -c 300 /tmp/call_deepchat_reply.json)"
