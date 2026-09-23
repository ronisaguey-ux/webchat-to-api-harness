#!/usr/bin/env node
'use strict';
//
// bin/webchat.js — the executable entry point.
//
// This file exists so `npm link` / `npm i -g .` produces a real global
// `webchat` command, while `./webchat` keeps working from a bare clone with no
// install step at all. It is deliberately thin: everything lives in cli/.
//
// It checks for the two things that would otherwise fail with an unhelpful
// stack trace — Node too old, and dependencies not installed.

const path = require('path');
const fs = require('fs');

const REPO = path.join(__dirname, '..');

const major = Number(process.versions.node.split('.')[0]);
if (Number.isNaN(major) || major < 18) {
    process.stderr.write(
        `webchat needs Node 18 or newer (found ${process.versions.node}).\n`,
    );
    process.exit(1);
}

if (!fs.existsSync(path.join(REPO, 'node_modules'))) {
    process.stderr.write(
        'webchat: dependencies are not installed.\n'
        + `  cd ${REPO} && npm install\n`,
    );
    process.exit(1);
}

require(path.join(REPO, 'cli', 'index.js'))
    .main(process.argv.slice(2))
    .then((code) => process.exit(code || 0))
    .catch((e) => {
        process.stderr.write(`webchat: ${(e && e.message) || e}\n`);
        process.exit(1);
    });
