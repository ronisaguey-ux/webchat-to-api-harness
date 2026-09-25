'use strict';
//
// The MCP setup prompt — a self-contained instruction set the user copies and pastes into
// their own agent (Claude Code, opencode, Cursor, whatever they run) so THAT agent wires
// this harness up as an MCP server.
//
// Why a prompt rather than a config file: we cannot write into another product's config.
// The client may be on a different machine (the platform question one screen earlier exists
// precisely because the agent is often not on this box), its config path and schema vary by
// client and by version, and guessing wrong leaves the user with a server that never starts
// and no error. An agent on the user's own machine can read that config, understand its
// shape, and write it correctly - so the deliverable is a briefing for that agent.
//
// PLATFORM-AWARE ON PURPOSE: it is generated immediately after the user answers
// "which system is your agent running on?", and that answer changes the shell, the path
// separators, and how the path must be escaped inside JSON. A Windows command emitted to a
// Linux agent (or a backslash eaten by JSON escaping) is a setup that fails with a parse
// error the user cannot interpret.

const REPO_URL = 'https://github.com/ronisaguey-ux/webchat-to-api-harness';

// JSON needs the separator escaped, or `C:\new` becomes a newline.
function jsonPath(p, platform) {
    return platform === 'windows' ? String(p).replace(/\\/g, '\\\\') : String(p);
}

function mcpSetupPrompt(opts = {}) {
    const platform = opts.platform === 'windows' ? 'windows' : 'linux';
    const win = platform === 'windows';
    const serverPath = opts.serverPath || '<path to>/webchat-to-api-harness/src/tools/mcp-server.js';
    const toolCount = Number(opts.toolCount) || 43;
    const repoUrl = opts.repoUrl || REPO_URL;
    const nodeMin = '20.12';

    const shell = win ? 'cmd.exe' : 'bash';
    const sep = win ? 'backslashes (`C:\\Users\\me\\...`)' : 'forward slashes (`/home/me/...`)';

    const configJson = [
        '{',
        '  "mcpServers": {',
        '    "webchat-harness": {',
        '      "command": "node",',
        `      "args": ["${jsonPath(serverPath, platform)}"]`,
        '    }',
        '  }',
        '}',
    ].join('\n');

    return `Wire the webchat-harness MCP server into this agent.

=====================================================================
CONTEXT — what you are setting up
=====================================================================

"webchat-to-api-harness" turns a real, logged-in webchat tab (DeepSeek, Gemini,
ChatGPT, ...) into an OpenAI-compatible API, and exposes itself over MCP so an agent
can drive it: add and connect webchats, read logs and health, change settings, and
put whole tasks through a webchat as a subagent.

  Repo:        ${repoUrl}
  MCP entry:   src/tools/mcp-server.js
  Runtime:     Node.js >= ${nodeMin}   (verify: node --version)
  Transport:   stdio (JSON-RPC on stdin/stdout)
  Tools:       ${toolCount}

The system I am on is: ${platform.toUpperCase()}
  - shell is ${shell}
  - paths use ${sep}
  - if you write a path into a JSON config, escape the separators so the string parses

=====================================================================
HOW IT WORKS — read this before you wire it up
=====================================================================

- The server is a single Node process started with no arguments. It speaks MCP over
  stdio and stays running for the life of the agent session.

- ★ STDOUT IS THE WIRE. NOTHING MAY PRINT TO IT. Every diagnostic, warning and log line
  must go to stderr. A single stray \`console.log\` between two JSON-RPC frames corrupts
  the stream, and the client reports it as a JSON parse error that reads like the server
  being broken. If you extend the server, redirect all console methods to stderr at
  startup, before loading any module that might log.

- It is ZERO-DEPENDENCY and has no build step. Nothing to compile, no package to publish.

- The server answers even when the harness is not running: \`webchat_status\` reports what
  it can see. Tools that DRIVE a webchat (\`webchat_ask\`, \`webchat_swarm_run\`,
  \`webchat_subagent_spawn\`) need a gateway process running and a webchat tab that has been
  connected and signed in. A tool that cannot reach a webchat should say so, not hang.

- The tool families, so you know what is available:
    status / health   ${'webchat_status, webchat_doctor, webchat_health_all, webchat_metrics,'}
                      webchat_probe_lane, webchat_paths, webchat_version, webchat_platform
    webchats (gates)  webchat_gate_add, webchat_gate_launch, webchat_gate_confirm,
                      webchat_gate_remove, webchat_tools_list, webchat_tool_toggle
    settings          webchat_config_list, webchat_config_get, webchat_config_set,
                      webchat_config_reset, webchat_prompt
    talking to one    webchat_ask, webchat_newchat, webchat_handoff, webchat_call_tool,
                      webchat_threads, webchat_window
    lifecycle         webchat_start, webchat_stop, webchat_restart, webchat_logs
    other agent CLIs  webchat_harness_list, webchat_launch_agent, webchat_launch_config
    background jobs   webchat_subagent_spawn, webchat_subagent_list,
                      webchat_subagent_result, webchat_subagent_cancel
    memory            webchat_memory_read, webchat_memory_write, webchat_memory_append
    safety / bulk     webchat_sandbox_check, webchat_swarm_run, webchat_swarm_race
    local judgement   webchat_decide  (yes/no, choice, or score — no model call)

=====================================================================
SETUP — do these in order, and report what each one returned
=====================================================================

1. Confirm Node is new enough. Run:
     node --version
   It must be >= ${nodeMin}. If it is older or missing, STOP and tell me - do not
   continue and do not silently install a different runtime.

2. Locate the harness on THIS machine. I expect it at:
     ${serverPath}
   If it is not there, find it, or clone it:
     git clone ${repoUrl}
   Then set SERVER to the absolute path of src/tools/mcp-server.js inside that clone.
   ${win ? 'Use Windows path style with backslashes.' : 'Use an absolute path, not a relative one - the client may start the server from any working directory.'}

3. Verify the server runs and see its real surface. Run:
     node "$SERVER" --list
   Expect a line reading "${toolCount} tools" followed by the tool names.
   If that number differs from ${toolCount}, the copy is older or newer than this prompt -
   tell me the number you got rather than assuming.

4. Register it in YOUR OWN MCP configuration. Find the config file this agent reads for
   MCP servers - do not guess it. Common locations, but confirm against your own docs:
     - a project-scoped file in the current working directory
     - a user-scoped file under the application's config directory
   (${win ? 'on Windows these are usually under %APPDATA%, not $HOME' : 'on Linux these are usually under ~/.config or ~/.local/share, following XDG'})

   The entry it needs, in the scheme most MCP clients use:

${configJson.split('\n').map((l) => '     ' + l).join('\n')}

   IMPORTANT: match the SCHEMA that client actually uses. Some clients want
   "command" + "args" as above; some want a single "command" array; some use a
   "type": "stdio" field. Read the file you are editing, mirror its existing entries,
   and if it is empty, check that client's documentation for the shape. A config in
   the wrong shape fails silently - the tools simply never appear.

5. Restart the agent (or reload its MCP servers) so the new server is picked up, then
   confirm the tools are visible. Ask for the harness status first: it is read-only and
   safe.

=====================================================================
IF IT DOES NOT WORK - the three real causes, in order
=====================================================================

1. THE CONFIG IS IN THE WRONG SHAPE OR THE WRONG FILE. Most common by far. A server
   written into a file the client does not read, or with the wrong key layout, produces
   no tools and no error.

2. THE PATH IS WRONG FOR THE MACHINE. A relative path, a path from a different machine,
   or a Windows path handed to a POSIX shell. Verify the exact path exists before
   writing it into the config.

3. THE PROCESS STARTS AND DIES, OR PRINTS SOMETHING. Run it by hand exactly as the
   client would:
     node "$SERVER"
   It should sit there waiting on stdin with NO output. Any banner, warning or log line
   on stdout is the bug - it is corrupting the protocol stream.

=====================================================================
CONSTRAINTS
=====================================================================

- Do NOT commit or push anything, and do NOT modify the harness source to make this work.
  This is a wiring job.
- Do NOT edit any other MCP server's entry, and do not reformat the config file.
- Do NOT print, echo or log secrets. If you read a config containing a token, leave it
  on disk and refer to it by name.
- The harness may be running and in use. Do not restart it, kill it, or stop its
  browser - if a step seems to need that, ask me first.

=====================================================================
DONE MEANS
=====================================================================

- \`node "$SERVER" --list\` printed the tool list with the count above.
- The server is registered in the config file THIS agent actually reads.
- The tools are visible to you after a reload, and a read-only call worked
  (harness status or version).
- You told me: the absolute path you used, the config file you wrote, and the output of
  the two commands above.

That is the whole job. Do not do more than this.`;
}

module.exports = { mcpSetupPrompt, REPO_URL };
