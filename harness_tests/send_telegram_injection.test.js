const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { executeTool } = require('../src/tools/tools');

test('send_telegram_message does not execute shell command substitution', async () => {
  const marker = '/tmp/pwned_marker_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  try {
    await executeTool('send_telegram_message', { text: `hello $(touch ${marker})` });
    const exists = fs.existsSync(marker);
    assert.strictEqual(exists, false, `Marker file ${marker} should not exist but was created via command substitution`);
  } finally {
    if (fs.existsSync(marker)) {
      try { fs.unlinkSync(marker); } catch (_) {}
    }
  }
});
