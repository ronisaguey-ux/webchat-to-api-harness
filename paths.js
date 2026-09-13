'use strict';

// ── Portable path resolution ────────────────────────────────────────────────
// The harness used to hardcode absolute paths like
//   /home/roni/Roni_Workspace/audits_plans/claude_inbox.json
// which only exist on the author's machine. On any other box (Windows
// especially) the same string resolves to C:\home\roni\... and every write
// fails with ENOENT — a user reported exactly that:
//   "A drift report write failed: ENOENT: no such file or directory, open
//    'C:\\home\\roni\\Roni_Workspace\\audits_plans\\claude_inbox.json'"
//
// Resolution order, first hit wins:
//   1. the explicit env var for that path (WORKSPACE_ROOT, AUDITS_PLANS_DIR, …)
//   2. WORKSPACE_ROOT, when set
//   3. the harness's parent directory (the harness normally sits at
//      <workspace>/webchat-api)
// Nothing here assumes a username, a drive letter, or a POSIX separator.

const path = require('path');
const os = require('os');

function envDir(name) {
    const v = process.env[name];
    return v && String(v).trim() ? path.resolve(String(v).trim()) : null;
}

function workspaceRoot() {
    return envDir('WORKSPACE_ROOT') || path.resolve(__dirname, '..');
}

function auditsPlans() {
    return envDir('AUDITS_PLANS_DIR') || path.join(workspaceRoot(), 'audits_plans');
}

// Every path the harness writes to. Each is env-overridable, and each falls
// back to a location derived from the workspace root rather than a hardcoded
// absolute string.
const paths = {
    workspaceRoot,
    auditsPlans,

    driftReportDir: () => envDir('DRIFT_REPORT_DIR') || path.join(auditsPlans(), 'drift_reports'),
    mainInboxFile: () => envDir('MAIN_INBOX_FILE') || path.join(auditsPlans(), 'claude_inbox.json'),
    mainReplyFile: () => envDir('MAIN_REPLY_FILE') || path.join(auditsPlans(), 'claude_webchat_outbox.json'),
    mainReplySeenFile: (port) => envDir('MAIN_REPLY_SEEN_FILE')
        || path.join(auditsPlans(), '.main_reply_seen_' + (port || process.env.PORT || 8080) + '.json'),
    webchatInboxFile: () => envDir('WEBCHAT_INBOX_FILE') || path.join(auditsPlans(), 'claude_webchat_inbox.json'),
    outboxFile: () => envDir('OUTBOX_FILE') || path.join(auditsPlans(), 'claude_outbox.json'),
    workflowStateFile: () => envDir('WORKFLOW_STATE_FILE') || path.join(auditsPlans(), 'workflow_state.json'),
    auditStateFile: () => envDir('AUDIT_STATE_FILE') || path.join(auditsPlans(), 'audit_state.json'),
    handoffFile: () => envDir('HANDOFF_FILE') || path.join(workspaceRoot(), 'handoff_to_new_chat.md'),
    bashToolLog: () => envDir('BASH_TOOL_LOG') || path.join(__dirname, 'bash_tool_log.jsonl'),
    homeDir: () => os.homedir(),
};

module.exports = paths;
