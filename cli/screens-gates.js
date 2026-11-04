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
            for (const l of A.boxLines('Webchats — the ones you have added', body)) A.line(l);
            A.newline();
            A.line(A.gray(`  Add a webchat offers every site: ${siteNames}, Generic.`));

            // Connected webchats are a checkbox list: they are what the agent may use.
            // A connected webchat is FINISHED — offering "Reconnect" on it made the
            // screen read as a to-do list and dead-ended on a Back button.
            const launch = LC.read();
            const picked = new Set(launch.gates || []);
            const ready = gates.filter((g) => g.connected);
            // ONLY the webchats that are live are listed. A configured-but-signed-out
            // entry used to sit here as "Connect Gemini", which read as a to-do item for a
            // webchat the user had not added, and turned the list into a list of things
            // that do not work. A webchat appears here when it is signed in and answering.

            const items = ready.map((g) => ({
                label: `${picked.has(g.id) ? '[x]' : '[ ]'} ${g.label}`,
                hint: `connected · gateway :${g.gatewayPort || '—'}`,
                value: `pick:${g.id}`,
            }));
            items.push({
                label: 'Add a webchat',
                hint: 'pick a site (or Generic for any site), then log in',
                value: 'add',
            });
            if (gates.length) {
                items.push({ label: 'Remove a webchat', hint: 'forgets it here; the Chrome profile is left alone', value: 'remove' });
            }
            items.push({ label: 'Back', value: 'back' });

            const choice = await A.menu(items, {
                title: 'Webchats',
                startIndex: menuStart,
                footer: ready.length
                    ? ['Enter picks the webchats your agent may use — pick more than one if you like.']
                    : ['No webchat yet — Add a webchat opens a browser for you to log into.'],
            });
            if (choice === A.BACK || choice === 'back') return;
            if (choice === 'add') { await screenAddGate(); continue; }
            if (choice === 'remove') { await screenRemoveGate(); continue; }
            if (String(choice).startsWith('conn:')) { await screenConnectGate(String(choice).slice(5)); continue; }
            if (String(choice).startsWith('pick:')) {
                const id = String(choice).slice(5);
                if (picked.has(id)) picked.delete(id); else picked.add(id);
                LC.write({ gates: [...picked] });
                // Keep the cursor on the row just toggled instead of snapping to the top.
                menuStart = items.findIndex((i) => i.value === `pick:${id}`);
                if (menuStart < 0) menuStart = 0;
                continue;
            }
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
        // Harness ports start ABOVE the ranges the rest of this box already uses:
        // 8081/8082/8083 are oculus gateway units and 9225-9230 are their chromes, so
        // the old 9225+/8081+ allocation collided with them. `webchat connect` then
        // reported a healthy gateway that was in fact an oculus lane, and a request for
        // one webchat's model came back answered by a DIFFERENT webchat's browser.
        // Ports the OS says are free, so the user never has to know which numbers the
        // rest of the machine is using.
        // Adding a site that is already saved REUSES its gate: same profile, same ports,
        // same entry. A second gate for the same site would list the webchat twice and
        // make the user sign in again for nothing.
        const existing = G.read().gates.find((g) => g.site === site.id);
        let gate = existing;
        if (!gate) {
            const { cdpPort, gatewayPort } = await G.freePortPair();
            gate = G.add({
                site: site.id,
                url: site.url,
                cdpPort,
                gatewayPort,
            });
        }

        A.clear();
        header(['Webchats', `opening ${gate.label}`]);
        A.newline();
        A.line(`  ${A.gray('starting a browser for')} ${A.bold(gate.label)}`);
        A.line(`  ${A.gray('profile')} ${shortHome(gate.profile)}`);
        A.newline();

        const res = D.launchBrowser({ cdpPort: gate.cdpPort, profile: gate.profile, url: site.url || 'about:blank' });
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
            A.dim('Come back here when you are done and the CLI will read the tab.'),
        ], 'Check the tab');

        // Straight on to the check, so adding a webchat FINISHES the job. Leaving the user
        // to hunt for a Connect row is how the list filled up with things that did not work.
        await screenConnectGate(gate.id);
    }

    async function screenPickActive() {
        // Refreshed, not read: this menu DISPLAYS connected state, and the stored flag
        // outlives the browser it describes — the same lie the dashboard had.
        const { gates, active } = await G.refresh(undefined, 30000);
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
        //
        // CANONICAL SHAPE. This used to write `{gate: <id>, ...}` (singular), while
        // `webchat start` writes `{gates: [{id, ...}]}` — so a reader expecting the array
        // saw "nothing connected" after a connect that had really happened. One shape, one
        // meaning: `gates` is always the array.
        const prevConn = D.readConnection() || {};
        D.writeConnection({
            gates: [{ id: gate.id, gatewayPort: gate.gatewayPort, cdpPort: gate.cdpPort }],
            mode: gate.site,
            agent: prevConn.agent || null,
            cdpWsUrl: prevConn.cdpWsUrl || null,
            targetUrl: prevConn.targetUrl || null,
            connectedAt: new Date().toISOString(),
        });

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

        // ONE harness (radio, not checkbox): an agentic harness takes over the
        // terminal, so running two at once is not a thing you can do.
        const items = H.HARNESSES.map((h) => {
            const has = H.installed(h);
            return {
                label: `${chosen.has(h.id) ? '(●)' : '( )'} ${h.label}`,
                hint: has ? h.note : `${h.bin} is not installed`,
                value: h.id,
            };
        });
        items.push({ label: 'Back', value: 'back' });

        const pick = await A.menu(items, {
            title: 'Agentic harness',
            footer: ['Enter picks the agent to run — one at a time.'],
            startIndex,
        });
        if (pick === A.BACK || pick === 'back') return;
        if (!H.installed(H.harnessById(pick))) {
            await panel('Not installed', [
                `${A.bold(H.harnessById(pick).label)} is not installed.`,
                '',
                A.dim(`Install ${H.harnessById(pick).bin} first, then pick it here.`),
            ], 'Back');
            return screenHarnesses(items.findIndex((i) => i.value === pick));
        }
        // Replace, never accumulate — and persist immediately, because the re-entrant
        // call rebuilds the choice from this file.
        LC.write({ harnesses: [pick] });
        return screenHarnesses(items.findIndex((i) => i.value === pick));
    }

