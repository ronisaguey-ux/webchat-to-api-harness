#!/usr/bin/env bash
# bash completion for `webchat`.
#
#   source /path/to/completions/webchat.bash
#   # or, permanently:
#   echo 'source /path/to/completions/webchat.bash' >> ~/.bashrc
#
# Set WEBCHAT_WORKER to the worker folder this drives; it defaults to the same
# place the `webchat` script does.
_webchat_worker() { printf '%s\n' "${WEBCHAT_WORKER:-$HOME/.local/share/webchat_worker}"; }

_webchat() {
  local cur prev cmds
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"

  cmds="code connect status new tabs shot show window minimize headless restart logs stop"

  case "$prev" in
    connect)
      # Offer whatever webchat tab is currently open, by host.
      local ep
      ep="$(curl -s -m 1 "http://127.0.0.1:${WEBCHAT_CDP_PORT:-9222}/json/list" 2>/dev/null \
            | grep -oE '"url": *"https?://[^"/]+' | sed 's/.*"//' | sort -u)"
      COMPREPLY=( $(compgen -W "${ep:-gemini chatgpt deepseek kimi}" -- "$cur") )
      return 0 ;;
    shot)
      COMPREPLY=( $(compgen -f -- "$cur") ); return 0 ;;
  esac

  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "$cmds" -- "$cur") )
    return 0
  fi

  case "${COMP_WORDS[1]}" in
    code|logs)
      # `code` takes a wait in seconds; `logs` takes nothing.
      COMPREPLY=() ;;
  esac
  return 0
}
complete -F _webchat webchat
