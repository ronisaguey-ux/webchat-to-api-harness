const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const config = require('./config');

// ──────────────────────────────────────────────────────
// TOOL DEFINITIONS
// ──────────────────────────────────────────────────────
const TOOL_DEFINITIONS = [
    {
        name: 'read_file',
        category: 'file',
        description: 'Read contents of a file.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path to read' },
                // Optional head-only read: keeps big files (34KB App.jsx) from
                // ballooning the thread when only the top matters (08-12 context-
                // overflow spiral). Re-read WITHOUT maxLength before rewriting a
                // file so the rewrite never starts from a partial view.
                maxLength: { type: 'integer', description: 'Optional — read only the first N characters; the result flags truncation' },
            },
            required: ['path'],
        },
        handler: async (args) => {
            const content = fs.readFileSync(args.path, 'utf-8');
            if (args.maxLength && content.length > args.maxLength) {
                return {
                    success: true,
                    truncated: true,
                    totalLength: content.length,
                    content: content.slice(0, args.maxLength),
                };
            }
            return { success: true, content };
        },
    },
    {
        name: 'write_file',
        category: 'file',
        description: 'Write content to a file.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path to write to' },
                content: { type: 'string', description: 'Content to write' },
            },
            required: ['path', 'content'],
        },
        handler: async (args) => {
            fs.writeFileSync(args.path, args.content, 'utf-8');
            return { success: true, message: `Written to ${args.path}` };
        },
    },
    {
        // SECURITY: disabled unless BASH_ALLOWED=true. The webchat model's
        // output is executed verbatim here — a prompt-injected or hostile
        // response could run anything on this machine.
        name: 'run_bash',
        category: 'system',
        description: 'Run a bash command on this machine (disabled unless BASH_ALLOWED=true).',
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Bash command to execute' },
            },
            required: ['command'],
        },
        handler: (args) =>
            new Promise((resolve) => {
                if (!config.bashAllowed) {
                    return resolve({
                        success: false,
                        error:
                            'run_bash is disabled. Set BASH_ALLOWED=true in .env to enable ' +
                            '(it executes webchat-model-controlled strings — read the README warning).',
                    });
                }
                const cmd = String(args.command || '');
                // spawn + stdio→temp files instead of execFile + pipes: execFile
                // waits for the pipes to CLOSE, so `cmd &` (backgrounded servers)
                // blocked until the timeout — the model's "uvicorn ... &" hung
                // every request a full 60s (2nd session 08-12). bash -c exits
                // immediately after backgrounding; 'exit' fires, we resolve, and
                // the background child survives (detached) writing to the files.
                // On timeout, kill(-pid) takes the whole process group — the old
                // code killed only bash and orphaned the foreground child.
                const outFile = `${os.tmpdir()}/webchat_exec_${process.pid}_${Date.now()}.out`;
                const errFile = outFile.replace(/\.out$/, '.err');
                const outFd = fs.openSync(outFile, 'w');
                const errFd = fs.openSync(errFile, 'w');
                const child = spawn('/bin/bash', ['-c', cmd], {
                    detached: true,
                    stdio: ['ignore', outFd, errFd],
                });
                let settled = false;
                const finish = (extra) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    try { fs.closeSync(outFd); } catch (e) { /* already closed */ }
                    try { fs.closeSync(errFd); } catch (e) { /* already closed */ }
                    let stdout = '';
                    let stderr = '';
                    try { stdout = fs.readFileSync(outFile, 'utf8'); } catch (e) { /* gone */ }
                    try { stderr = fs.readFileSync(errFile, 'utf8'); } catch (e) { /* gone */ }
                    // Orphans may keep appending — read the tail, then unlink so
                    // the files can't grow unbounded.
                    if (stdout.length > config.execMaxBuffer) stdout = stdout.slice(-config.execMaxBuffer);
                    if (stderr.length > config.execMaxBuffer) stderr = stderr.slice(-config.execMaxBuffer);
                    try { fs.unlinkSync(outFile); } catch (e) { /* already gone */ }
                    try { fs.unlinkSync(errFile); } catch (e) { /* already gone */ }
                    resolve({ success: true, ...extra, stdout, stderr: stderr || '' });
                };
                child.on('error', (err) => finish({ success: false, error: err.message }));
                child.on('exit', (code) =>
                    finish(code === 0 ? {} : { success: false, error: `exit code ${code}` }));
                const timer = setTimeout(() => {
                    try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* already gone */ }
                    finish({ success: false, error: `timed out after ${Math.round(config.execTimeoutMs / 1000)}s` });
                }, config.execTimeoutMs);
            }),
    },
    {
        name: 'list_dir',
        category: 'file',
        description: 'List contents of a directory.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Directory path' },
            },
            required: ['path'],
        },
        handler: async (args) => {
            const files = fs.readdirSync(args.path);
            return { success: true, files };
        },
    },
    {
        name: 'search_web',
        category: 'web',
        description: 'Search the web for information.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query' },
            },
            required: ['query'],
        },
        handler: async (args) => {
            // Placeholder — integrate a real search API if you want results
            return {
                success: true,
                result: `[Simulated search for: "${args.query}"]`,
            };
        },
    },
];

// ──────────────────────────────────────────────────────
// TOOL EXECUTOR
// ──────────────────────────────────────────────────────
function getToolDefinitions() {
    // Expose only the schema (name/category/description/parameters), never the handler
    return TOOL_DEFINITIONS.map(({ handler, ...rest }) => rest);
}

async function executeTool(toolName, args) {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === toolName);
    if (!tool) {
        return {
            success: false,
            error: `Tool "${toolName}" not found. Available: ${TOOL_DEFINITIONS.map((t) => t.name).join(', ')}`,
        };
    }
    console.log(`🔧 Executing: ${toolName}(${JSON.stringify(args)})`);
    try {
        const result = await tool.handler(args || {});
        console.log(`✅ Tool ${toolName} executed.`);
        return result;
    } catch (e) {
        console.warn(`⚠️  Tool ${toolName} failed:`, e.message);
        return { success: false, error: e.message };
    }
}

// ──────────────────────────────────────────────────────
// TOOL-CALL PARSER
//    Accepts bare JSON, ```json fences, and prose-wrapped JSON.
//    Scans for the first balanced {...} block that parses as
//    {"tool": "...", "params": {...}}.
// ──────────────────────────────────────────────────────
function parseToolCall(response) {
    if (typeof response !== 'string') return { isToolCall: false, content: String(response) };

    // 08-12: scan EVERY balanced {...} block, not just the first. The old code
    // pinned `start` at the FIRST '{' — if any prose before the JSON contained
    // a brace ("added {x: 1} to the code"), the candidate spanned prose+JSON,
    // JSON.parse failed, and the scan NEVER advanced: valid tool-call replies
    // were rejected as yaps (the 2-rejections-before-every-call pattern in the
    // 2nd session; the DeepThink reasoning block that used to ride along in the
    // extracted text was exactly such brace-poisoned prose). Cap attempts so a
    // pathological prose-y reply can't turn this into an O(n^2) grind.
    const text = response.replace(/```(?:json)?/g, '').trim();
    let start = text.indexOf('{');
    let attempts = 0;
    while (start !== -1 && attempts++ < 8) {
        let depth = 0;
        let inString = false;
        let escaped = false;
        let end = -1;
        for (let i = start; i < text.length; i++) {
            const c = text[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (c === '\\') escaped = true;
                else if (c === '"') inString = false;
                continue;
            }
            if (c === '"') inString = true;
            else if (c === '{') depth++;
            else if (c === '}') {
                depth--;
                if (depth === 0) { end = i; break; }
            }
        }
        if (end === -1) {
            // 08-13: scan ran off the end of the reply with braces still open
            // — DeepSeek's renderer truncates the LAST brace of a fenced JSON
            // reply ("...work on it."} missing the final }). The old code
            // gave up here, the reply fell through conversation mode as raw
            // `json Copy Download {...}` text (user report 08-13). Repair:
            // close the open string if the cut landed inside one, close the
            // open braces, and attempt a parse. A repaired candidate that
            // still isn't a tool call just fails the JSON.parse below — the
            // only cost is the extra attempt, and we break after it.
            let repaired = text.slice(start);
            if (inString) repaired += '"';
            repaired += '}'.repeat(Math.min(depth, 20));
            try {
                const obj = JSON.parse(repaired);
                if (obj && typeof obj === 'object' && obj.tool && obj.params) {
                    return { isToolCall: true, toolName: String(obj.tool), args: obj.params };
                }
            } catch {
                /* not recoverable — nothing more to try */
            }
            break;
        }
        const candidate = text.slice(start, end + 1);
        try {
            const obj = JSON.parse(candidate);
            if (obj && typeof obj === 'object' && obj.tool && obj.params) {
                return { isToolCall: true, toolName: String(obj.tool), args: obj.params };
            }
        } catch {
            /* not JSON — try the next block */
        }
        start = text.indexOf('{', start + 1);
    }
    return { isToolCall: false, content: response };
}

// ──────────────────────────────────────────────────────
// EXPORTS
// ──────────────────────────────────────────────────────
module.exports = {
    TOOL_DEFINITIONS,
    getToolDefinitions,
    executeTool,
    parseToolCall,
};
