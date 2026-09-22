#compdef webchat
# zsh completion for `webchat`. Install by placing this file somewhere on
# $fpath as _webchat, or source it directly:
#
#   source /path/to/completions/webchat.zsh

_webchat() {
  local -a cmds
  cmds=(
    'code:open the browser and wait for a signed-in webchat tab'
    'connect:detect the open tab and wire the gateway to it'
    'status:what is running and what it is attached to'
    'new:open a fresh empty thread'
    'tabs:list the webchat tabs the browser exposes'
    'shot:screenshot the tab'
    'show:raise the browser window (for a login or a CAPTCHA)'
    'window:raise the window and keep the gateway down'
    'minimize:drop the window back down'
    'headless:run the browser headless (may sign you out)'
    'restart:restart the gateway only'
    'logs:follow the gateway log'
    'stop:stop the gateway'
  )
  _describe 'webchat command' cmds
}
_webchat "$@"
