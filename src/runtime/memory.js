'use strict';
//
// memory.js — the harness's persistent memory file.
//
// The owner asked for "a memory file that the user or agent can edit". A single
// markdown file (default <workspaceRoot>/webchat_memory.md, env MEMORY_FILE to
// move it) that:
//
//   * the MODEL can read and edit through the read_memory / edit_memory tools,
//     so it can persist facts across sends;
//   * the CLI can open and edit (it is a normal setting in cli/settings.js);
//   * is included in the system prompt, so what is written is actually in effect.
//
// Bounded: it rides into EVERY request's prompt, so a runaway edit must never be
// able to balloon it. MAX_MEMORY_CHARS caps the stored file AND the prompt slice.
// Edits are whole-file (overwrite) and append, no in-place patching — the file is
// small by design.

const fs = require('fs');
const path = require('path');
const PATHS = require('../core/paths');

const MAX_MEMORY_CHARS = parseInt(process.env.MAX_MEMORY_CHARS || '20000', 10);

function memoryFile() {
    return process.env.MEMORY_FILE
        ? path.resolve(process.env.MEMORY_FILE)
        : path.join(PATHS.workspaceRoot(), 'webchat_memory.md');
}

function readMemory() {
    try {
        return fs.readFileSync(memoryFile(), 'utf-8');
    } catch (e) {
        return ''; // no memory yet — not an error
    }
}

// Write a bounded file. The contents are capped at MAX_MEMORY_CHARS so a bad
// model edit cannot turn the memory file into a prompt bomb.
function writeMemory(content) {
    const text = String(content ?? '').slice(0, MAX_MEMORY_CHARS);
    const file = memoryFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Atomic: write a temp then rename, so a crash mid-write never leaves a
    // truncated memory file that silently wipes every persisted fact.
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text, 'utf-8');
    fs.renameSync(tmp, file);
    return text;
}

function appendMemory(content) {
    const existing = readMemory();
    const merged = (existing ? existing.trimEnd() + '\n\n' : '') + String(content ?? '');
    return writeMemory(merged);
}

// The system-prompt slice. Kept short on purpose — it repeats on every request.
function memoryBlock() {
    const text = readMemory();
    if (!text.trim()) return '';
    return '### MEMORY (persistent facts across sessions — you may edit this with edit_memory)\n'
        + text.slice(0, MAX_MEMORY_CHARS)
        + '\n### END MEMORY\n';
}

module.exports = { memoryFile, readMemory, writeMemory, appendMemory, memoryBlock, MAX_MEMORY_CHARS };
