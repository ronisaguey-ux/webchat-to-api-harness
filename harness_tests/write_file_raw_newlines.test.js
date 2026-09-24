'use strict';
//
// WHY THE LANE READ FOR 34 TOOL CALLS AND WROTE NOTHING.
//
// A model writing a whole file emits its content as a JSON string and very often leaves
// the line breaks RAW instead of writing \n. That is invalid JSON, so the envelope is
// rejected, the write is DISCARDED, the log says only "malformed tool JSON", a correction
// is sent, the model retries in the same shape, the rounds burn, and it eventually gives
// up and submits a summary of work it never did.
//
// Measured on the live lane: it emitted a 12,836-char reply containing a complete
// write_file for DataLakeView.jsx; the parser returned 0 calls; the run then answered
// "Successfully updated ... Verified by building the project successfully" having
// written nothing.
//
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const { parseToolCalls } = require(path.join(__dirname, '..', 'tools.js'));

const fileBody = [
    'import React, { useState } from "react";',
    'import { Database } from "lucide-react";',
    '',
    'export default function X() {',
    '  const [a, setA] = useState(0);',
    '  return <div className="p-4">{a}</div>;',
    '}',
].join('\n');

// Build VALID JSON, then un-escape ONLY the newlines. That is precisely the model's error:
// quotes and everything else escaped correctly, the line breaks left raw.
function rawNewlineEnvelope(obj) {
    return JSON.stringify(obj)
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t');
}

test('a write_file with raw newlines in its content still parses', () => {
    const reply = '```json\n' + rawNewlineEnvelope({ tool: 'write_file', path: '/p/x.jsx', content: fileBody }) + '\n```';
    const r = parseToolCalls(reply);
    assert.strictEqual(r.toolCalls.length, 1,
        'the write must survive — discarding it is why the lane could not write files');
    assert.strictEqual(r.toolCalls[0].toolName, 'write_file');
});

test('the content survives byte for byte, escapes and all', () => {
    const reply = '```json\n' + rawNewlineEnvelope({ tool: 'write_file', path: '/p/x.jsx', content: fileBody }) + '\n```';
    const got = parseToolCalls(reply).toolCalls[0].args.content;
    assert.strictEqual(got, fileBody, 'a repaired envelope must not alter the document');
    assert.ok(got.includes('className="p-4"'), 'the escaped quotes must come back as quotes');
    assert.strictEqual(got.split('\n').length, fileBody.split('\n').length, 'every line preserved');
});

test('a nested params envelope is repaired the same way', () => {
    const reply = JSON.stringify({ tool: 'write_file', params: { path: '/p/x.jsx', content: fileBody } })
        .replace(/\\n/g, '\n');
    const r = parseToolCalls(reply);
    assert.strictEqual(r.toolCalls.length, 1);
    assert.strictEqual(r.toolCalls[0].args.content, fileBody);
});

test('a real multi-line source file round-trips', () => {
    // The actual file the lane was rewriting when this was found.
    const real = '/home/roni/Roni_workspace/helpotron/web/src/components/DataLakeView.jsx';
    if (!fs.existsSync(real)) return;   // absent on a fresh clone — not a failure
    const content = fs.readFileSync(real, 'utf-8');
    const reply = '💬 I am going to update the file.\n\n```json\n'
        + rawNewlineEnvelope({ tool: 'write_file', path: real, content }) + '\n```';
    const r = parseToolCalls(reply);
    assert.strictEqual(r.toolCalls.length, 1);
    assert.strictEqual(r.toolCalls[0].args.content, content, '297 lines must survive intact');
});

test('valid JSON is not altered by the repair', () => {
    // The repair is only applied after a parse FAILS, and escaping a raw control
    // character can only turn invalid JSON into valid JSON — so a document that was
    // already fine can never be touched.
    const clean = JSON.stringify({ tool: 'write_file', path: '/p/x.jsx', content: fileBody });
    const r = parseToolCalls('```json\n' + clean + '\n```');
    assert.strictEqual(r.toolCalls[0].args.content, fileBody);
    assert.ok(!r.toolCalls[0].args.content.includes('\\n'), 'a literal backslash-n must not appear');
});
