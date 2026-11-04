'use strict';
//
// screens-gates.js — the screens for gates, harnesses and the primed launch.
//
// Kept in its own file because index.js was already 1,200 lines and this is a
// distinct area: it is the part of the CLI the owner asked to be plain, obvious and
// multi-everything (many webchats, many harnesses, one primed config).
//
// Every screen here takes `ctx` — the small bundle of helpers from index.js
// (A = ansi, D = daemon, G = gates, H = harnesses, LC = launchconfig, and the local
// header/shortHome/panel helpers). Threading them explicitly keeps this module
// testable and keeps the two files from growing an import cycle.
//
const os = require('os');
const path = require('path');

function build(ctx) {
    const { A, D, G, H, LC, header, shortHome, panel } = ctx;
    // The settings layer, so a screen can read a raw dotted path (the limits map has no
    // per-tool schema entry to resolve through).
    const S = ctx.S || require('./settings.js');

    // ── Gates ────────────────────────────────────────────────────────────────
    //
    // The list of webchats. This replaces the old single "connection": a user can hold
    // several, see which browser is actually running, and mark each connected.
    async function screenGates() {
        let menuStart = 0;
        for (;;) {
            // Refreshed: a gate is only offered as connected while its tab is actually
            // signed in and answering, so an expired session stops being selectable.
            const { gates, active } = await G.refresh(undefined, 30000);

            A.clear();
            header(['Webchats']);

            const body = [];
            const siteNames = G.SITES.filter((s) => !s.generic).map((s) => s.label.replace(/\s*\(.*\)$/, '')).join(', ');
            if (!gates.length) {
                body.push(A.gray('No webchats yet.'));
                body.push('');
                body.push(`Add one and the CLI opens a browser for you to log into.`);
                body.push(`Pick ${A.bold('Generic')} if your site is not listed — it opens an empty`);
                body.push(`browser and you navigate wherever you like.`);
            } else {
