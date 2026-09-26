const test = require('node:test');
const assert = require('node:assert');
const { executeTool } = require('../src/tools/tools');

test('git_status includes error output when repository path is missing', async () => {
  const res = await executeTool('git_status', { repo: 'oculus' });
  assert.strictEqual(res.success, false);
  assert.ok(res.error, 'res.error must be present when git command fails');
  assert.match(res.error, /(cannot change to|No such file|fatal)/i);
});

test('git_status on a real repository returns branch status and commits', async () => {
  const res = await executeTool('git_status', { repo: 'helpotron' });
  assert.strictEqual(res.success, true);
  assert.ok(res.branchStatus && res.branchStatus.length > 0, 'branchStatus should not be empty');
  assert.ok(res.recentCommits && res.recentCommits.length > 0, 'recentCommits should not be empty');
});
