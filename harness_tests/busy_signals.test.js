'use strict';
// Busy-signal regression tests (2026-09-22).
//
// The defect these pin: `isForeignBusy()` handled the phantom-stop quirk by
// returning false for the ENTIRE scan —
//
//     if (phantomStop) return false;
//
// which sits ABOVE the aria-busy scans. So on Gemini (the one lane with
// `phantomStopButton: true`) the ChatGPT aria-busy signal was discarded as
// well, and the lane reported "not busy" for its whole thinking window. The
// empty-response grace counted that window as silence and threw
//   "Webchat response is empty after 600s — stopped or aborted by the UI"
// while the model was still working — measured as `raw=11 clean=0` for 270s
// with the content arriving at t+285s.
//
// The quirk means "this lane's STOP CONTROL lies". It does not mean the lane
// has no readable busy state, and the fix scopes it to the stop-control scans
// only. Case 2 below is the one that FAILS against the pre-fix code.
//
// `busyProbe` is exported and pure (DOM in, boolean out), so this needs no
// browser — which is exactly why the bug survived: every previous check of it
// required launching Chrome.
const test = require('node:test');
const assert = require('node:assert');

const { busyProbe } = require('../browser.js');

// ── A minimal DOM ───────────────────────────────────────────────────────────
function makeEl(opts = {}) {
    const {
        tag = 'div', attrs = {}, text = '', visible = true, disabled = false, busyChild = false,
    } = opts;
    const el = {
        tagName: tag.toUpperCase(),
        innerText: text,
        disabled,
        getAttribute: (n) => (Object.prototype.hasOwnProperty.call(attrs, n) ? attrs[n] : null),
        offsetParent: visible ? {} : null,
        getClientRects: () => (visible ? [{}] : []),
        querySelector: (sel) => (busyChild && sel === '[aria-busy="true"]' ? makeEl({ attrs: { 'aria-busy': 'true' } }) : null),
    };
    return el;
}

// Dispatch for exactly the selectors busyProbe uses.
function installDom({ assistantRows = [], ariaLabels = [], buttons = [], testIds = [], stopButton = null } = {}) {
    const byBusy = assistantRows.filter((r) => r.getAttribute('aria-busy') === 'true');
    const byTestIdStop = testIds.filter((e) => (e.getAttribute('data-testid') || '').toLowerCase().includes('stop'));

    global.document = {
        querySelectorAll(sel) {
            switch (sel) {
            case '[data-message-author-role="assistant"][aria-busy="true"]': return byBusy;
            case '[data-message-author-role="assistant"]': return assistantRows;
            case '[aria-label]': return ariaLabels;
            case 'button': return buttons;
            case '[data-testid]': return testIds;
            default: return [];
            }
        },
        querySelector(sel) {
            if (sel === '[data-testid="stop-button"]') return stopButton;
            return null;
        },
    };
    global.window = {
        getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    };
}

const restore = () => { delete global.document; delete global.window; };

// ── The cases ───────────────────────────────────────────────────────────────

test('1. idle lane with no signals reads not-busy', () => {
    installDom();
    assert.strictEqual(busyProbe({ phantomStop: false }), false);
    restore();
});

test('2. BUG: phantomStop must NOT disable the aria-busy signal', () => {
    // Gemini's lane. The row is genuinely in flight; its stop control is a
    // phantom. Pre-fix this returned FALSE and the grace ran out mid-generation.
    installDom({
        assistantRows: [
            makeEl({ attrs: { 'data-message-author-role': 'assistant' } }),
            makeEl({ attrs: { 'data-message-author-role': 'assistant', 'aria-busy': 'true' } }),
        ],
        ariaLabels: [makeEl({ attrs: { 'aria-label': 'Stop response' } })],
    });
    assert.strictEqual(busyProbe({ phantomStop: true }), true,
        'an assistant row reporting aria-busy is in flight regardless of the stop quirk');
    restore();
});

test('3. phantomStop still refuses to trust the phantom stop control itself', () => {
    // This is what the quirk is FOR: Gemini leaves "Stop response" mounted and
    // visible after the answer commits. Reading it as busy made the PRE-SEND
    // guard throw "still generating from a previous request" on every follow-up.
    installDom({
        ariaLabels: [makeEl({ attrs: { 'aria-label': 'Stop response' } })],
    });
    assert.strictEqual(busyProbe({ phantomStop: true }), false,
        'a phantom stop control must not mark the tab busy');
    restore();
});

test('3b. the same stop control IS trusted on a lane without the quirk', () => {
    installDom({ ariaLabels: [makeEl({ attrs: { 'aria-label': 'Stop generating' } })] });
    assert.strictEqual(busyProbe({ phantomStop: false }), true);
    restore();
});

test('4. a stop-ish BUTTON is a signal only on a non-phantom lane', () => {
    installDom({ buttons: [makeEl({ tag: 'button', text: 'Stop' })] });
    assert.strictEqual(busyProbe({ phantomStop: false }), true);
    assert.strictEqual(busyProbe({ phantomStop: true }), false);
    restore();
});

test('5. ChatGPT data-testid stop control is still honoured', () => {
    installDom({ testIds: [makeEl({ attrs: { 'data-testid': 'stop-button' } })] });
    assert.strictEqual(busyProbe({ phantomStop: false }), true);
    restore();
});

test('6. a nested aria-busy child marks its assistant row in flight', () => {
    installDom({
        assistantRows: [makeEl({ attrs: { 'data-message-author-role': 'assistant' }, busyChild: true })],
    });
    assert.strictEqual(busyProbe({ phantomStop: true }), true);
    restore();
});

test('7. an invisible stop control is not a signal', () => {
    installDom({
        ariaLabels: [makeEl({ attrs: { 'aria-label': 'Stop response' }, visible: false, disabled: true })],
        buttons: [makeEl({ tag: 'button', text: 'Stop', visible: false })],
    });
    assert.strictEqual(busyProbe({ phantomStop: false }), false);
    restore();
});

test('8. a disabled stop control is not a signal', () => {
    installDom({ ariaLabels: [makeEl({ attrs: { 'aria-label': 'Stop response' }, disabled: true })] });
    assert.strictEqual(busyProbe({ phantomStop: false }), false);
    restore();
});
