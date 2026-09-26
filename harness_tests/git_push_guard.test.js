'use strict';
// The git-push guard must reason about the DESTINATION, not the spelling of a branch name.
//
// The old check took the last non-flag token that was not `origin`/`upstream` and compared it
// to 'main'/'master'. So it blocked `git push origin main` and then allowed every refspec that
// names the same destination another way — measured against the real logic:
//
//     git push origin HEAD:main            -> allowed
//     git push origin refs/heads/main      -> allowed
//     git push origin +main                -> allowed (a FORCE push to main)
//     git push origin feature/x:main       -> allowed
//
// A prompt-injected or merely buggy subagent could therefore push straight to the default
// branch while the guard reported it was protecting it.
//
// It must also not over-block: `release/master` is a different ref from `master`, and a guard
// that stops legitimate work is an outage rather than a fix.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const tools = require(path.join(__dirname, '..', 'src', 'tools', 'tools.js'));
const { pushDestination } = tools;

// Mirror of the executor's decision, so the tests read like the guard does.
function blocked(cmd) {
    const toks = cmd.split(/\s+/).filter(Boolean);
    const pi = toks.indexOf('push');
    const d = pushDestination(toks.slice(pi + 1));
    return !d.branch || d.forbidden;
}

test('every route to the default branch is blocked', () => {
    const mustBlock = [
        'git push origin main',
        'git push origin master',
        'git push -f origin main',
        'git push --force origin master',
        'git push origin HEAD:main',
        'git push origin HEAD:master',
        'git push origin refs/heads/main',
        'git push origin refs/heads/master',
        'git push origin +main',                 // force-push refspec
        'git push origin +master',
        'git push origin main:main',
        'git push origin feature/x:main',        // push a local branch ONTO main
        'git push origin feature/x:master',
        'git push -u origin main',
        'git push',                              // no refspec: the current branch, unknown
    ];
    for (const cmd of mustBlock) {
        assert.strictEqual(blocked(cmd), true, `should be blocked: ${cmd}`);
    }
});

test('legitimate feature-branch pushes are allowed', () => {
    const mustAllow = [
        'git push origin feature/x',
        'git push -u origin feat/y',
        'git push origin feature/x:feature/y',
        'git push origin refs/heads/feature/z',
        'git push origin fix/main-logic',        // contains "main", is not the branch
        'git push origin release/master',        // a different ref from master
        'git push origin docs/update-main-guide',
    ];
    for (const cmd of mustAllow) {
        assert.strictEqual(blocked(cmd), false, `should be allowed: ${cmd}`);
    }
});

test('the destination is reported, so the refusal can explain itself', () => {
    const d = pushDestination(['origin', 'HEAD:main']);
    assert.strictEqual(d.forbidden, true);
    assert.strictEqual(d.branch, 'main', 'the refusal should name the destination it refused');
});

test('a bare push with no refspec is denied rather than assumed safe', () => {
    const d = pushDestination([]);
    assert.strictEqual(d.forbidden, true,
        'pushing the current branch is an unreviewed default, not an explicit feature branch');
    assert.strictEqual(d.branch, null);
});
