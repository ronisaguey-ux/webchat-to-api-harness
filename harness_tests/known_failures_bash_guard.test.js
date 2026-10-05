'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// DELIBERATELY RED. Every test in this file FAILS on purpose.
//
// It is the regression test for a product defect this audit found in
// src/tools/bash_guard.js. The fix belongs to whoever owns bash_guard.js — this
// branch changes no product code. Run it on its own:
//
//     node --test harness_tests/known_failures_bash_guard.test.js
//
// THE DEFECT (verified on commit 9dfeeda, 2026-10-05)
//
// bash_guard.js exists to close one hole: the old guard matched the raw command
// string, so `git push origin HEAD:main`, `git push origin main:main` and
// `git push -u origin main && echo ok` all reached main. Its stated contract, in
// its own header comment, is:
//
//   "It splits a command into the simple commands the shell will run (on ; && || |
//    & newlines, subshell and command-substitution brackets) … Anything it cannot
//    read as a clean push to a feature branch is refused: the cost of a refused
//    push is one retry with an explicit branch; the cost of a wrong allow is a
//    commit on main."
//
// The splitter has no notion of the SHELL KEYWORDS that open and close a compound
// command — if/then/elif/else/fi, for/while/until/do/done, case/esac, [[ ]]. Those
// words arrive as ordinary argv entries, so the command the shell actually runs is
// not the first element of any argv:
//
//     argvs('if true; then git push origin main; fi')
//       -> [["if","true"], ["then","git","push","origin","main"], ["fi"]]
//                   ^^^^  the argv pushDenial actually inspects
//
// pushArgvDenial() returns null at `if (a[i] !== 'push') return null` (line 175)
// because argv[0] is "then", and argvDanger() compares argv[0] against a table of
// program names, so "then"/"do"/"else" match nothing. Both guards then report the
// command as safe.
//
// MEASURED — these all currently return null (allowed):
//
//     if true; then git push origin main; fi                    -> allowed
//     if true; then git push origin main; else git push origin master; fi -> allowed
//     while read x; do git push origin main; done               -> allowed
//     for f in a; do git push origin main; done                  -> allowed
//     until false; do git push origin main; done                 -> allowed
//     if true; then rm -rf /tmp/x; fi                            -> allowed
//     for f in a; do rm -rf /tmp/x; done                         -> allowed
//     while :; do node -e "x"; done                              -> allowed
//     git push origin $BRANCH                                    -> allowed
//
// WHAT MAKES THIS WORTH FIXING RATHER THAN DOCUMENTING: the dangerous half of the
// list is a silent allow of irreversible commands. A prompt-injected subagent that
// is told "do not push to main" can wrap the push in `if true; then … fi` and the
// guard reports success. Nothing downstream re-checks; run_bash is the only gate.
//
// A NOTE ON `git push origin $BRANCH`, the last case: the guard cannot expand a
// variable, and refusing every unexpanded `$VAR` refspec would break ordinary work,
// so that one may reasonably stay allowed. It is listed for completeness, not as a
// claimed defect — the eight cases above are the demonstrated ones.
//
// HOW TO MAKE THIS FILE PASS: strip shell keywords as structural separators in
// `lex()`/`commands()` (or drop any argv whose first token is one of
// if/then/elif/else/fi/for/while/until/do/done/case/esac/select/function/time/!),
// so the real command becomes argv[0] and both guards see it again. Nothing in the
// fix has to change the deny-list itself.
// ─────────────────────────────────────────────────────────────────────────────

const test = require('node:test');
const assert = require('node:assert');
const guard = require('../src/tools/bash_guard');

test('DEFECT: `if … then git push origin main; fi` must be refused', () => {
  const why = guard.pushDenial('if true; then git push origin main; fi');
  assert.ok(why, 'push to main hidden behind the `then` keyword was allowed');
});

test('DEFECT: both branches of an if/else must be inspected', () => {
  const why = guard.pushDenial('if true; then git push origin main; else git push origin master; fi');
  assert.ok(why, 'if/else hid two pushes to a protected branch');
});

test('DEFECT: a push inside while/for/until must be refused', () => {
  for (const cmd of [
    'while read x; do git push origin main; done',
    'for f in a; do git push origin main; done',
    'until false; do git push origin main; done',
  ]) {
    assert.ok(guard.pushDenial(cmd), cmd);
  }
});

test('DEFECT: a destructive command behind a keyword must be refused', () => {
  for (const cmd of [
    'if true; then rm -rf /tmp/x; fi',
    'for f in a; do rm -rf /tmp/x; done',
    'while :; do node -e "x"; done',
  ]) {
    assert.ok(guard.dangerDenial(cmd), cmd);
  }
});

test('the same three commands are already refused without the keyword', () => {
  // Control: proves the guards work and that only the keyword path is broken.
  // If THIS test fails, the defect above is not the cause any more.
  assert.ok(guard.pushDenial('git push origin main'));
  assert.ok(guard.dangerDenial('rm -rf /tmp/x'));
  assert.ok(guard.dangerDenial('node -e "x"'));
});