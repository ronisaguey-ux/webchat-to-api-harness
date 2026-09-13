'use strict';

// ── Master config loader ────────────────────────────────────────────────────
// Reads harness.config.json so every feature can be turned on or off (and given
// a specific value) in ONE place, instead of hunting through systemd drop-ins.
//
// Precedence, highest first:
//   1. environment variable
//   2. harness.config.json
//   3. the built-in default in config.js
//
// The file is optional: a missing or malformed harness.config.json falls back to
// an empty object and the harness behaves exactly as before.

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = process.env.HARNESS_CONFIG
    ? path.resolve(process.env.HARNESS_CONFIG)
    : path.join(__dirname, 'harness.config.json');

let raw = {};
let loadError = null;
try {
    if (fs.existsSync(CONFIG_FILE)) {
        const text = fs.readFileSync(CONFIG_FILE, 'utf-8');
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') raw = parsed;
    }
} catch (e) {
    loadError = e;
}

function get(section, key) {
    const s = raw[section];
    if (!s || typeof s !== 'object') return undefined;
    return s[key];
}

// A non-empty environment variable always wins. `undefined` from the file means
// "not configured" and the caller's own default applies.
function pick(envName, section, key) {
    if (envName && process.env[envName] !== undefined && process.env[envName] !== '') {
        return process.env[envName];
    }
    return get(section, key);
}

// Booleans: env is the string 'true'/'false'; the file is a real boolean.
function pickBool(envName, section, key) {
    const env = envName ? process.env[envName] : undefined;
    if (env !== undefined && env !== '') return String(env).toLowerCase() === 'true';
    const v = get(section, key);
    if (v === undefined || v === null) return undefined;
    return v === true || String(v).toLowerCase() === 'true';
}

// Numbers: env is a string; the file is a number. 0 is a legitimate value.
function pickNum(envName, section, key) {
    const env = envName ? process.env[envName] : undefined;
    if (env !== undefined && env !== '') {
        const n = Number(env);
        if (!Number.isNaN(n)) return n;
    }
    const v = get(section, key);
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    return Number.isNaN(n) ? undefined : n;
}

// Strings, with the empty string treated as "not configured" so a blank entry in
// the file does not blank out a real default.
function pickStr(envName, section, key) {
    const env = envName ? process.env[envName] : undefined;
    if (env !== undefined && env !== '') return env;
    const v = get(section, key);
    if (v === undefined || v === null || v === '') return undefined;
    return String(v);
}

// Comma-separated list: env is a string, the file may be an array or a string.
function pickList(envName, section, key) {
    const env = envName ? process.env[envName] : undefined;
    if (env !== undefined && env !== '') {
        return env.split(',').map((s) => s.trim()).filter(Boolean);
    }
    const v = get(section, key);
    if (v === undefined || v === null) return undefined;
    if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
    return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

module.exports = { pick, pickBool, pickNum, pickStr, pickList, raw, loadError, CONFIG_FILE };
