'use strict';
//
// settings.js — the complete setting surface, as data.
//
// `config.js` resolves every setting with the precedence
//     environment variable  >  harness.config.json  >  a built-in default
// which is the right precedence for a machine that is configured by systemd
// drop-ins, and a footgun for anyone editing the file: a value you change in
// harness.config.json does nothing if the matching env var is set, and nothing
// tells you. So this module does three jobs:
//
//   1. SCHEMA  — every setting the harness actually reads, with its env var,
//                its type, and a plain-English description. This is the single
//                source the CLI renders from; adding a setting here is what
//                makes it appear in the UI.
//   2. RESOLVE — the effective value AND WHERE IT CAME FROM, so the UI can say
//                "set by BASH_ALLOWED in the environment" instead of silently
//                ignoring an edit. `shadowedBy` is the field that makes this
//                honest.
//   3. WRITE   — atomic edits to harness.config.json (backup first) and to .env
//                for the handful of values that are env-only.
//
// Anything not in SCHEMA is still readable through `raw` (for per-mode
// selectors and quirks, which are nested and edited as a block).

const fs = require('fs');
const path = require('path');

// The memory file is file-backed, not config-JSON-backed: its `memory.contents`
// setting reads/writes the actual file. Load it lazily so a broken memory module
// cannot take the CLI down.
const memoryMod = (() => { try { return require('../src/runtime/memory'); } catch { return null; } })();

// ── The schema ─────────────────────────────────────────────────────────────
// type: bool | number | string | list | enum | secret | longtext
// risk: shown as a warning banner; these loosen a guardrail.
// Build one settings entry per tool, read from the live registry.
//
