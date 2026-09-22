# Shell completions

Tab-completion for the `webchat` driver.

**bash**

```bash
source /path/to/completions/webchat.bash        # this shell
echo 'source /path/to/completions/webchat.bash' >> ~/.bashrc   # every shell
```

**zsh**

```zsh
source /path/to/completions/webchat.zsh
```

The `connect` completion asks the browser's debug port for the tabs that are
actually open and offers their hosts, so it completes against your real session
rather than a hardcoded list.
