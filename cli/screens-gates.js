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

    // ── Gates ────────────────────────────────────────────────────────────────
    //
    // The list of webchats. This replaces the old single "connection": a user can hold
    // several, see which browser is actually running, and mark each connected.
    async function screenGates() {
        for (;;) {
            const { gates, active } = G.read();

            A.clear();
            header(['Webchats']);

            const body = [];
            if (!gates.length) {
                body.push(A.gray('No webchats yet.'));
                body.push('');
                body.push(`Add one and the CLI opens a browser for you to log into.`);
                body.push(`Pick ${A.bold('Generic')} if your site is not listed — it opens an empty`);
                body.push(`browser and you navigate wherever you like.`);
            } else {
                // One block per gate, so the state of each is legible at a glance.
                for (const g of gates) {
                    const marks = [];
                    marks.push(g.id === active ? A.cyan('● active') : A.gray('○'));
                    marks.push(g.connected ? A.green('connected') : A.gray('not connected'));
                    body.push(`${marks.join('  ')}   ${A.bold(g.label)}  ${A.gray(`(${g.site})`)}`);
                    body.push(`       ${A.dim('url')}     ${g.url || A.gray('(you choose in the browser)')}`);
                    body.push(`       ${A.dim('gateway')} :${g.gatewayPort || '—'}    ${A.dim('browser')} :${g.cdpPort || '—'}`);
                }
            }
            for (const l of A.boxLines('Webchats — one per account', body)) A.line(l);
            A.newline();

            const items = [{ label: 'Add a webchat', hint: 'pick a site (or Generic for any site)', value: 'add' }];
            for (const g of gates) {
                items.push({
                    label: `${g.connected ? 'Reconnect' : 'Connect'} ${g.label}`,
                    hint: g.connected ? 're-verify the tab and re-save' : 'launch, log in, then confirm',
                    value: `conn:${g.id}`,
                });
            }
            if (gates.length) {
                items.push({
                    label: 'Choose which one to use',
                    hint: `currently: ${active || 'none'}`,
                    value: 'active',
                });
                items.push({ label: 'Remove a webchat', hint: 'forgets it here; the Chrome profile is left alone', value: 'remove' });
            }
            items.push({ label: 'Back', value: 'back' });

            const choice = await A.menu(items, { title: 'Webchats' });
            if (choice === A.BACK || choice === 'back') return;
            if (choice === 'add') await screenAddGate();
            else if (choice === 'active') await screenPickActive();
            else if (choice === 'remove') await screenRemoveGate();
            else if (String(choice).startsWith('conn:')) await screenConnectGate(String(choice).slice(5));
        }
    }

    async function screenAddGate() {
        const pick = await A.menu(
            G.SITES.map((s) => ({
                label: s.label,
                hint: s.generic ? 'opens an empty browser' : new URL(s.url).host,
                value: s.id,
            })).concat([{ label: 'Back', value: 'back' }]),
            { title: 'Which webchat?' },
        );
        if (pick === A.BACK || pick === 'back') return;

        const site = G.siteById(pick);
        const body = [
            `${A.bold(site.label)}`,
            '',
            site.note,
            '',
            A.dim('What happens next:'),
            `  1. A browser window opens on your desktop.`,
            site.generic
                ? `  2. Log in and navigate to the site you want to drive.`
                : `  2. Log into ${site.label} in that window.`,
            `  3. Come back here and confirm — it becomes a webchat the CLI can use.`,
        ];
        const go = await A.menu([{ label: 'Open the browser', value: 'go' }, { label: 'Back', value: 'back' }],
            { title: 'Ready?' });
        if (go !== 'go') return;

        // Ports: give each gate its own browser and gateway port so two gates can run
        // side by side. Derived from how many already exist, so the first is the
        // classic 9225/8081 and later ones step up.
        const { gates } = G.read();
        const cdpPort = 9225 + gates.length;
        const gatewayPort = 8081 + gates.length;

        const gate = G.add({
            site: site.id,
            url: site.url,
            cdpPort,
            gatewayPort,
        });

        A.clear();
        header(['Webchats', `opening ${gate.label}`]);
        A.newline();
        A.line(`  ${A.gray('starting a browser for')} ${A.bold(gate.label)}`);
        A.line(`  ${A.gray('profile')} ${shortHome(gate.profile)}`);
        A.newline();

        const res = D.launchBrowser({ cdpPort, profile: gate.profile, url: site.url || 'about:blank' });
        if (!res || res.error) {
            await panel('Could not open the browser', [
                A.red(String((res && res.error) || 'launch failed')),
                '',
                A.dim('Nothing is lost — the webchat is saved. Open the browser from the'),
                A.dim('Webchats list when you are ready.'),
            ]);
            return;
        }

        await panel('The browser is open', [
            site.generic
                ? `Log in and navigate to the site you want to drive.`
                : `Sign into ${site.label} in that window.`,
            '',
            A.yellow('The CLI cannot tell whether you are logged in.'),
            A.dim(`A signed-out ${site.label} looks exactly like a signed-in one from`),
            A.dim('here, so this is your call to make — which is why there is a Confirm step.'),
            '',
            A.dim(`When you are signed in, choose "${gate.label}" → Connect in the Webchats list.`),
        ], 'Back to Webchats');

        // Remember it as the working gate so the next screen has something to connect.
        G.setActive(gate.id);
    }

    async function screenPickActive() {
        const { gates, active } = G.read();
        const pick = await A.menu(
            gates.map((g) => ({ label: g.label, hint: g.connected ? 'connected' : 'not connected', value: g.id }))
                .concat([{ label: 'Back', value: 'back' }]),
            { title: `Which webchat should be primary? (now: ${active || 'none'})` },
        );
        if (pick === A.BACK || pick === 'back') return;
        G.setActive(pick);
    }

    async function screenRemoveGate() {
        const { gates } = G.read();
        const pick = await A.menu(
            gates.map((g) => ({ label: `Remove ${g.label}`, hint: g.id, value: g.id }))
                .concat([{ label: 'Back', value: 'back' }]),
            { title: 'Remove which webchat?' },
        );
        if (pick === A.BACK || pick === 'back') return;
        const sure = await A.confirm(`Remove "${pick}"?`, {
            footer: ['The Chrome profile is left on disk, so you can add it back without logging in again.'],
        });
        if (sure === true) G.remove(pick);
    }

    // Launch (if needed), let the user log in, then verify and mark connected.
    async function screenConnectGate(id) {
        let gate = G.get(id);
        if (!gate) return;

        A.clear();
        header(['Webchats', `connecting ${gate.label}`]);
        A.newline();

        // Is the browser for this gate running?
        let probe = await G.probe(gate);
        if (!probe.running) {
            A.line(`  ${A.gray('browser is not running — opening it now')}`);
            A.newline();
            const res = D.launchBrowser({ cdpPort: gate.cdpPort, profile: gate.profile, url: gate.url || 'about:blank' });
            if (res && res.error) {
                await panel('Could not open the browser', [A.red(res.error)]);
                return;
            }
            // Give Chrome a moment to bind its debug port before probing again.
            await new Promise((r) => setTimeout(r, 4000));
            probe = await G.probe(gate);
        }

        const conn = D.readConnection();
        const body = [
            `${A.dim('browser')}  ${probe.running ? A.green(`running on CDP :${gate.cdpPort}`) : A.red('not answering')}`,
            `${A.dim('tabs')}     ${probe.tabs} open${probe.liveTabUrl ? `  ${A.gray(probe.liveTabUrl.slice(0, 60))}` : ''}`,
            `${A.dim('target')}   ${gate.url || A.gray('(you choose where you navigated)')}`,
        ];
        if (!probe.running) {
            body.push('');
            body.push(A.yellow('Chrome did not answer on its debug port.'));
            body.push(A.dim('Close any window already using this profile and try again — a'));
            body.push(A.dim('persistent profile can only have one browser.'));
        } else if (probe.tabs === 0) {
            body.push('');
            body.push(A.yellow('The browser is up but has no tabs.'));
        }
        for (const l of A.boxLines('Check the window', body)) A.line(l);
        A.newline();

        if (!probe.running) {
            await panel('Nothing to connect yet', [
                A.dim('Reopen the browser from the Webchats list, then try again.'),
            ], 'Back');
            return;
        }

        A.line(`  ${A.bold('Is the site open and logged in in that window?')}`);
        A.line(`  ${A.gray('We cannot verify this for you — a signed-out page can look signed in.')}`);
        A.newline();

        const choice = await A.menu([
            { label: 'Yes — connect it', hint: 'saves the tab and marks this webchat connected', value: 'yes' },
            { label: 'Not yet', hint: 'leave it; nothing is saved', value: 'no' },
            { label: 'Open the browser again', value: 'reopen' },
        ], { title: '' });

        if (choice === 'reopen') {
            D.launchBrowser({ cdpPort: gate.cdpPort, profile: gate.profile, url: gate.url || 'about:blank' });
            await new Promise((r) => setTimeout(r, 3000));
            return screenConnectGate(id);
        }
        if (choice !== 'yes') return;

        gate = G.update(id, {
            connected: true,
            cdpPort: probe.running ? gate.cdpPort : gate.cdpPort,
            liveTabUrl: probe.liveTabUrl || null,
            connectedAt: new Date().toISOString(),
        });
        G.setActive(id);
        // Keep the old single-connection file in step: other tooling reads it, and a
        // half-truth there (connected to a gate that no longer exists) is worse than
        // no file at all.
        D.writeConnection({ gate: gate.id, mode: gate.site, cdpPort: gate.cdpPort, gatewayPort: gate.gatewayPort });

        await panel('Connected', [
            `${A.green('✓')} ${A.bold(gate.label)} is now a webchat the CLI can use.`,
            '',
            A.dim('Next: choose your agentic harness and permission mode, then Launch.'),
        ], 'Back');
    }

    // ── Harnesses ────────────────────────────────────────────────────────────
    async function screenHarnesses(startIndex = 0) {
        const cfg = LC.read();
        const chosen = new Set(cfg.harnesses || []);

        A.clear();
        header(['Agentic harness']);
        const body = [
            `Which agent should run against your webchats.`,
            '',
            A.dim('Installed ones are marked. You can pick more than one — each gets its'),
            A.dim('own terminal, because they are interactive programs.'),
        ];
        for (const l of A.boxLines('Agentic harness', body)) A.line(l);
        A.newline();

        const items = H.HARNESSES.map((h) => {
            const has = H.installed(h);
            return {
                label: `${chosen.has(h.id) ? '[x]' : '[ ]'} ${h.label}`,
                hint: has ? h.note : `${h.bin} is not installed`,
                value: h.id,
                disabled: false,
            };
        });
        items.push({ label: 'Done', hint: chosen.size ? `${chosen.size} selected` : 'nothing selected', value: 'done' });

        const pick = await A.menu(items, {
            title: 'Agentic harness',
            footer: ['Enter toggles a harness on or off. Esc when you are done.'],
            startIndex,
        });
        if (pick === A.BACK) return;
        if (pick === 'done') {
            LC.write({ harnesses: [...chosen] });
            return;
        }
        if (chosen.has(pick)) chosen.delete(pick);
        else chosen.add(pick);
        // Re-open the list with the cursor still on the row just toggled. Re-entering
        // at 0 made every Enter look like it had thrown the selection away.
        const at = items.findIndex((i) => i.value === pick);
        return screenHarnesses(at >= 0 ? at : startIndex);
    }

    async function screenMode() {
        const cfg = LC.read();
        const pick = await A.menu(
            Object.values(H.MODES).map((m) => ({
                label: m.label,
                hint: m.blurb,
                value: m.id,
            })).concat([{ label: 'Back', value: 'back' }]),
            {
                title: `Permission mode (now: ${cfg.mode})`,
                footer: ['This is passed to your harness with the flags it understands.'],
            },
        );
        if (pick === A.BACK || pick === 'back') return;
        LC.write({ mode: pick });
    }

    // ── The primed config ────────────────────────────────────────────────────
    //
    // This is what `webchat connect` executes. Showing the exact command is the point:
    // the user can see what will happen, and run it themselves if they prefer.
    async function screenPlan() {
        const cfg = LC.read();
        const { gates } = G.read();
        const v = LC.validate(cfg, gates);

        A.clear();
        header(['Launch']);
        const body = [];

        body.push(`${A.dim('webchats')}   ${cfg.gates.length
            ? cfg.gates.map((id) => {
                const g = gates.find((x) => x.id === id);
                return g ? (g.connected ? A.green(g.label) : A.yellow(`${g.label} (not connected)`)) : A.red(id);
            }).join(', ')
            : A.gray('none selected')}`);
        body.push(`${A.dim('harness')}    ${cfg.harnesses.length ? cfg.harnesses.join(', ') : A.gray('none selected')}`);
        body.push(`${A.dim('mode')}       ${cfg.mode}${cfg.mode === 'yolo' ? A.red('  (no gate at all)') : ''}`);
        body.push(`${A.dim('directory')}  ${shortHome(cfg.cwd)}`);

        if (!v.ok) {
            body.push('');
            body.push(A.yellow('Not ready:'));
            for (const p of v.problems) body.push(`  ${A.gray('·')} ${p}`);
        }
        for (const l of A.boxLines('Ready to launch?', body)) A.line(l);

        // The exact command, copy-pasteable, so the click is never the only way.
        if (v.ok) {
            A.newline();
            A.line(`  ${A.dim('webchat connect runs exactly this:')}`);
            const primary = gates.find((g) => g.id === cfg.gates[0]);
            const env = H.envFor(cfg.gates.map((id) => gates.find((g) => g.id === id)).filter(Boolean));
            A.line(`  ${A.gray(`OPENAI_BASE_URL=${env.OPENAI_BASE_URL} HARNESS_MODEL_NAME=${env.HARNESS_MODEL_NAME}`)}`);
            for (const hid of cfg.harnesses) {
                const h = H.harnessById(hid);
                if (h) A.line(`  ${A.gray(`${h.bin} ${H.argvFor(h, cfg.mode).join(' ')}`.trim())}`);
            }
        }
        A.newline();

        const items = [
            { label: 'Choose webchats', hint: `${cfg.gates.length} selected`, value: 'pickgates' },
            { label: 'Choose harness', hint: cfg.harnesses.join(', ') || 'none', value: 'pickh' },
            { label: 'Permission mode', hint: cfg.mode, value: 'mode' },
        ];
        if (v.ok) items.push({ label: 'Launch now', hint: 'same as running webchat connect', value: 'go' });
        items.push({ label: 'Back', value: 'back' });

        const choice = await A.menu(items, { title: 'Launch' });
        if (choice === A.BACK || choice === 'back') return;
        if (choice === 'pickgates') await screenPickGates();
        else if (choice === 'pickh') await screenHarnesses();
        else if (choice === 'mode') await screenMode();
        else if (choice === 'go') return 'launch';
    }

    async function screenPickGates() {
        const cfg = LC.read();
        const { gates } = G.read();
        const chosen = new Set(cfg.gates || []);

        if (!gates.length) {
            await panel('No webchats yet', [A.dim('Add one from the Webchats list first.')]);
            return;
        }

        const items = gates.map((g) => ({
            label: `${chosen.has(g.id) ? '[x]' : '[ ]'} ${g.label}`,
            hint: `${g.site}${g.connected ? ' · connected' : ' · not connected'}`,
            value: g.id,
        }));
        items.push({ label: 'Done', hint: `${chosen.size} selected`, value: 'done' });

        const pick = await A.menu(items, {
            title: 'Which webchats should this harness use?',
            footer: ['The first one selected is the primary — it is what the harness opens on.'],
        });
        if (pick === A.BACK) return;
        if (pick === 'done') {
            // Keep the selection order stable: a Set preserves insertion order, but
            // re-selecting an already-selected gate would not reorder it. Order
            // matters because the primary is the first entry.
            LC.write({ gates: [...chosen] });
            return;
        }
        if (chosen.has(pick)) chosen.delete(pick);
        else chosen.add(pick);
        return screenPickGates();
    }

    // ── Tools ────────────────────────────────────────────────────────────────
    async function screenTools() {
        const st = ctx.state();
        const rows = ctx.rowsOf(st);
        const row = rows.find((r) => r.setting.path === 'tools.disabled');
        const disabled = new Set(Array.isArray(row.value) ? row.value : []);

        let names = [];
        try {
            // Ask the harness itself which tools exist, so this list cannot drift from
            // the real catalogue the way a hand-written copy would.
            names = require('../src/tools/tools').getToolDefinitions().map((t) => t.name);
        } catch { names = []; }

        const items = names.map((n) => ({
            label: `${disabled.has(n) ? '[ ]' : '[x]'} ${n}`,
            hint: disabled.has(n) ? 'switched off' : 'available',
            value: n,
        }));
        items.push({ label: 'Done', hint: `${disabled.size} switched off`, value: 'done' });

        const pick = await A.menu(items, {
            title: 'Tools the model may use',
            footer: ['A tool switched off is not offered to the model at all.'],
        });
        if (pick === A.BACK) return;
        if (pick === 'done') {
            await ctx.saveSetting('tools.disabled', [...disabled]);
            return;
        }
        if (disabled.has(pick)) disabled.delete(pick);
        else disabled.add(pick);
        return screenTools();
    }

    return {
        screenGates,
        screenAddGate,
        screenConnectGate,
        screenHarnesses,
        screenMode,
        screenPlan,
        screenPickGates,
        screenTools,
    };
}

module.exports = { build };
