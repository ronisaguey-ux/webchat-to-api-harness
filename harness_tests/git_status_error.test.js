const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { executeTool } = require('../src/tools/tools');

test('git_status includes error output when repository path is missing', async () => {
  // A real repo must NOT be the trigger here: `oculus` resolves and succeeds.
  // Point REPOS_ROOT at a directory that has no such repo so the failure is the
  // missing path itself, not a wrong root. REPOS_ROOT is read per call.
  const prev = process.env.REPOS_ROOT;
  process.env.REPOS_ROOT = '/tmp/opencode';
  try {
    const res = await executeTool('git_status', { repo: 'oculus' });
    assert.strictEqual(res.success, false);
    assert.ok(res.error, 'res.error must be present when git command fails');
    assert.match(res.error, /(cannot change to|No such file|fatal)/i);
  } finally {
    if (prev === undefined) delete process.env.REPOS_ROOT;
    else process.env.REPOS_ROOT = prev;
  }
});

test('git_status on a real repository returns branch status and commits', async () => {
  // SELF-CONTAINED ON PURPOSE. This test used to name a specific repo on this
  // machine, so it passed or failed depending on what happened to exist in the
  // caller's home directory - and it broke when that repo was deleted. It builds
  // its own throwaway repo instead, so it tests git_status and nothing else.
  const fs = require('fs');
  const os = require('os');
  const cp = require('child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-gitstatus-'));
  const repo = path.join(root, 'oculus');
  fs.mkdirSync(repo);
  const git = (a) => cp.execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@example.invalid']);
  git(['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(repo, 'f.txt'), 'one\n');
  git(['add', '.']);
  git(['commit', '-qm', 'first commit']);

  const prev = process.env.REPOS_ROOT;
  process.env.REPOS_ROOT = root;
  try {
    const res = await executeTool('git_status', { repo: 'oculus' });
    assert.strictEqual(res.success, true);
    assert.ok(res.branchStatus && res.branchStatus.length > 0, 'branchStatus should not be empty');
    assert.ok(res.recentCommits && res.recentCommits.length > 0, 'recentCommits should not be empty');
  } finally {
    if (prev === undefined) delete process.env.REPOS_ROOT;
    else process.env.REPOS_ROOT = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
