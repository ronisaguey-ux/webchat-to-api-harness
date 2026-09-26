'use strict';
//
// fs_snapshot.js — did a shell command change any file under the sandbox roots?
//
// The phantom guard used to decide that from the command TEXT (MUTATING_BASH_RE), which
// is wrong both ways: `python3 -c "open('a.py','w').write(…)"`, `touch`, `patch` and
// `npm install` changed files and counted as reads, while `ls > /dev/null` and
// `pytest 2>/dev/null` counted as writes because they contain `>`. Looking at the disk
// before and after the command answers the question actually being asked.
//
// Bounded: a walk that would exceed `limit` entries is abandoned and reported as
// `truncated`, and the caller falls back to reading the command text. Build and cache
// directories are skipped — they change on every test run and are not the work.

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set([
    '.git', 'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache',
    '.ruff_cache', '.cache', '.tox', '.next', '.turbo',
]);
const DEFAULT_LIMIT = parseInt(process.env.MUTATION_SNAPSHOT_LIMIT || '20000', 10);

function snapshot(roots, { limit = DEFAULT_LIMIT } = {}) {
    const files = new Map();
    const stack = [...new Set((roots || []).filter(Boolean))];
    while (stack.length) {
        const dir = stack.pop();
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (files.size >= limit) return { files, truncated: true };
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (!SKIP_DIRS.has(e.name)) stack.push(p);
                continue;
            }
            let st;
            try { st = fs.lstatSync(p); } catch { continue; }
            files.set(p, `${st.mtimeMs}:${st.size}`);
        }
    }
    return { files, truncated: false };
}

// true / false when both snapshots are complete; null when either was cut short and
// the answer is unknown.
function changed(before, after) {
    if (!before || !after || before.truncated || after.truncated) return null;
    if (before.files.size !== after.files.size) return true;
    for (const [p, sig] of after.files) {
        if (before.files.get(p) !== sig) return true;
    }
    return false;
}

module.exports = { snapshot, changed, SKIP_DIRS };
