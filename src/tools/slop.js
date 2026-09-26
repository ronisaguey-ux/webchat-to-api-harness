'use strict';
// slop.js — find placeholder code a write INTRODUCED.
//
// A model that cannot finish a function tends to leave a stub and then report the
// work as done: `pass  # TODO: implement`, `// ... rest of implementation`,
// `raise NotImplementedError`. Nothing in the pipeline looked at what was written,
// so such a turn passed the phantom guard (a real write did happen).
//
// Diff-aware: only lines that are new relative to the file before the turn are
// reported, so a file's pre-existing TODOs never fire. Code files only — a plan or
// README may legitimately say "TODO".

const path = require('path');

const CODE_EXT = new Set([
    '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.rs', '.go', '.java', '.kt', '.rb',
    '.sh', '.bash', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.swift', '.php', '.scala', '.lua',
]);

// A comment marker followed (anywhere later on the line) by the text.
const COMMENT = String.raw`(?:#|//|/\*|--)`;
const RULES = [
    { id: 'todo', re: new RegExp(String.raw`${COMMENT}.*\b(TODO|FIXME|XXX)\b`) },
    { id: 'placeholder', re: new RegExp(String.raw`${COMMENT}.*\b(placeholder|stub(bed)?|dummy implementation|implement (this|me|later))\b`, 'i') },
    { id: 'elided', re: new RegExp(String.raw`${COMMENT}\s*\.\.\.\s*(\(?\s*)?(rest|existing|remaining|same|other|more|previous)\b`, 'i') },
    { id: 'elided', re: /\.\.\.\s*(rest of|existing|remaining) (the )?(code|implementation|logic|file|function)/i },
    { id: 'not_implemented', re: /\b(raise\s+NotImplementedError|throw\s+new\s+Error\(\s*['"`][^'"`]*not\s+(yet\s+)?implemented|unimplemented!\(|todo!\()/i },
    { id: 'not_implemented', re: new RegExp(String.raw`${COMMENT}.*\bnot (yet )?implemented\b`, 'i') },
];
// A bare `pass` / `...` that is the whole body of a def/class.
const BARE_BODY = /^\s*(pass|\.\.\.)\s*(#.*)?$/;
const DEF_HEADER = /^\s*(async\s+)?(def|class)\s.*:\s*(#.*)?$/;

function isCode(file) {
    return CODE_EXT.has(path.extname(String(file || '')).toLowerCase());
}

/** Lines of `after` that are placeholders and were not in `before`. */
function slopScan(before, after, file) {
    if (file !== undefined && !isCode(file)) return [];
    const old = new Map();
    for (const l of String(before || '').split('\n')) old.set(l, (old.get(l) || 0) + 1);
    const lines = String(after || '').split('\n');
    const found = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const n = old.get(line) || 0;
        if (n > 0) { old.set(line, n - 1); continue; } // unchanged line
        let rule = RULES.find((r) => r.re.test(line));
        // An abstract method's `raise NotImplementedError` is the contract, not a stub.
        if (rule && rule.id === 'not_implemented' && lines.slice(Math.max(0, i - 4), i).some((l) => /@(abc\.)?abstractmethod/.test(l))) rule = null;
        if (!rule && BARE_BODY.test(line)) {
            let j = i - 1;
            while (j >= 0 && !lines[j].trim()) j--;
            if (j >= 0 && DEF_HEADER.test(lines[j])) rule = { id: 'empty_body' };
        }
        if (rule) found.push({ line: i + 1, rule: rule.id, text: line.trim().slice(0, 160) });
    }
    return found;
}

module.exports = { slopScan, isCode };
