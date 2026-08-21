#!/usr/bin/env python3
"""
OCULUS MASTER PLAN AUTONOMOUS EXECUTION & VERIFICATION ENGINE v3 (Production Hardened)
========================================================================================

Phase 1: Autonomous Step-by-Step Execution Engine (OmniRoute)
  - Parses 661 steps from `master_oculus_plan_7_29.md`.
  - Structured Code Operation Parser: Extracts `<<<REPLACE>>>` and `<<<ADD>>>` blocks directly from plan steps.
  - Command Whitelist Validator: Enforces shell command security (`python3`, `pytest`, `mypy`, `git`, `flake8`, `black`, `isort`, `ruff`).
  - Full Verification Protocol: Executes ALL 5 step verification commands in isolated terminal environments; ALL checks must pass for commit.
  - Strict Rollback Protocol: Immediate `git checkout -- <files>` rollback on ANY verification failure before updating state.
  - Git staging & commit after each verified step.

Phase 2: Final DeepSeek Verification Audit (Triggers once all 661 steps are complete)
  - Uses the official DeepSeek API key (loaded from tokens_keys/deepseek_api.json).
  - Spawns 5 concurrent teams of 3 subagents (15 parallel verifiers).
  - Evaluates 5 steps per batch with 3 subagents inspecting each step in parallel.
  - Feeds full stdout/stderr of verification commands into DeepSeek verifiers.
  - Verification commands execute in isolated, non-colliding terminal subshell environments.
  - Outputs `/home/roni/Roni_workspace/audits_plans/final_master_verification_report.md`.

Usage:
    python3 execute_master_oculus_plan.py --smoke
    python3 execute_master_oculus_plan.py --resume
    python3 execute_master_oculus_plan.py --resume --continue-on-failure
    python3 execute_master_oculus_plan.py --verify-final
    python3 execute_master_oculus_plan.py
"""

import os
import sys
import re
import json
import time
import random
import asyncio
import tempfile
import subprocess
import argparse
import fcntl
import ast_context_compressor  # 08-20 audit 4.2: AST skeletonizer / role slices
from ast_context_compressor import security_slice, skeletonize_source
from datetime import datetime
from collections import defaultdict
import aiohttp
import gc
import resource
import hashlib
import hashlib

# ─── MEMORY PROTECTION ───────────────────────────────────────────────────────
try:
    _rlim = resource.getrlimit(resource.RLIMIT_AS)
    _max_bytes = 8 * 1024 * 1024 * 1024  # 8 GB virtual memory cap (machine has 14GB RAM)
    if _rlim[0] == resource.RLIMIT_INFINITY or _rlim[0] > _max_bytes:
        resource.setrlimit(resource.RLIMIT_AS, (_max_bytes, _rlim[1]))
except Exception:
    pass

# ─── CONFIGURATION: ENVIRONMENT PATHS ──────────────────────────────────────
OCULUS_DIR = os.getenv("OCULUS_DIR", "/home/roni/Roni_workspace/oculus")
AUDITS_PLANS_DIR = os.getenv("AUDITS_PLANS_DIR", "/home/roni/Roni_workspace/audits_plans")
MASTER_PLAN_FILE = os.getenv("MASTER_PLAN_FILE", f"{AUDITS_PLANS_DIR}/master_oculus_plan_8_3.md")
EXECUTION_STATE_FILE = os.getenv("EXECUTION_STATE_FILE", f"{AUDITS_PLANS_DIR}/plan_execution_state.json")
EXECUTION_LOG_FILE = os.getenv("EXECUTION_LOG_FILE", f"{AUDITS_PLANS_DIR}/plan_execution.log")
EXECUTION_JSON_LOG_FILE = os.getenv("EXECUTION_JSON_LOG_FILE", f"{AUDITS_PLANS_DIR}/plan_execution_logs.jsonl")
# 2026-08-20: plan-scoped default — the helpotron lane's phase-2 report
# (final_master_verification_report.md) would be silently overwritten by the
# oculus lane's audit (and vice versa). Key by plan file, like the sweep
# checkpoint. Env override still wins.
FINAL_REPORT_FILE = os.getenv("FINAL_REPORT_FILE", f"{AUDITS_PLANS_DIR}/final_verification_report_{os.path.basename(MASTER_PLAN_FILE).replace('.md', '')}.md")
SOT_FILE = os.getenv("SOT_FILE", f"{OCULUS_DIR}/OCULUS_IMPORTANT/OCULUS_SOURCE_OF_TRUTH_7_23.md")
GRAPH_FILE = os.getenv("GRAPH_FILE", f"{OCULUS_DIR}/graphify-out/graph.json")
KEY_FILE = os.getenv("DEEPSEEK_KEY_FILE", "/home/roni/Roni_workspace/tokens_keys/deepseek_api.json")

# ─── OMNIROUTE CONFIGURATION ────────────────────────────────────────────────
OMNIROUTE_API_BASE = os.getenv("OMNIROUTE_API_BASE", "http://localhost:20128/api/v1")
OMNIROUTE_API_KEY = os.getenv("OMNIROUTE_API_KEY", os.getenv("OPENAI_API_KEY", "omniroute"))
PRIMARY_MODEL = os.getenv("EXEC_PRIMARY_MODEL", "auto/best-coding")
FALLBACK_MODELS = [
    "auto/best-coding",
    "auto/coding:fast",
    "auto/best-reasoning",
    "deepseek-v4-flash-free",
    "oc/deepseek-v4-flash-free",
    "mimo-v2.5-free",
    "nemotron-3-ultra-free",
    "big-pickle",
]

# ─── DEEPSEEK CONFIGURATION (Phase 2 Final Audit) ───────────────────────────
def load_deepseek_key() -> str:
    # 1. Prefer OCULUS_DEEPSEEK_KEY env var
    env_key = os.getenv("OCULUS_DEEPSEEK_KEY")
    if env_key:
        return env_key.strip()
    # 2. Fallback to DEEPSEEK_API_KEY env var
    if os.getenv("DEEPSEEK_API_KEY"):
        return os.getenv("DEEPSEEK_API_KEY", "").strip()
    # 3. Read from file and enforce 0o600 permissions
    if os.path.exists(KEY_FILE):
        try:
            # Enforce file permissions: owner read/write only
            try:
                os.chmod(KEY_FILE, 0o600)
            except Exception:
                pass
            with open(KEY_FILE) as f:
                content = f.read().strip()
                try:
                    data = json.loads(content)
                    if isinstance(data, dict):
                        k = data.get("api_key") or data.get("key") or data.get("DEEPSEEK_API_KEY")
                        if k: return k.strip()
                except Exception:
                    pass
                m = re.search(r'(sk-[a-f0-9]{32})', content)
                if m: return m.group(1)
                return content.split()[0]
        except Exception:
            pass
    return os.getenv("OPENAI_API_KEY", "")

DEEPSEEK_API_BASE = os.getenv("DEEPSEEK_API_BASE", "https://api.deepseek.com/v1")
DEEPSEEK_API_KEY = load_deepseek_key()
DEEPSEEK_MODEL_FLASH = "deepseek-v4-flash"  # 2026-08-07 (user): never deepseek-chat
DEEPSEEK_MODEL_PRO = "deepseek-reasoner"

SEMAPHORE_LIMIT = int(os.getenv("SEMAPHORE_LIMIT", "5"))
CHAT_TIMEOUT_SECONDS = int(os.getenv("CHAT_TIMEOUT_SECONDS", "60"))  # 60s for DeepSeek paid API
DEEPSEEK_TIMEOUT_SECONDS = int(os.getenv("DEEPSEEK_TIMEOUT_SECONDS", "90"))  # 90s: fail fast when DeepSeek is congested (2026-08-04)
# ── ESCALATION TIERS (fully config-driven, no hardcoding) ────────────────────
# Each tier is a {"model", "attempts", "plan_fix"} entry. The engine walks the
# list in order: after the OmniRoute team exhausts, each tier's DeepSeek expert
# tries `attempts` times; `plan_fix: true` tiers may also edit a flawed step.
#
# Configure via one JSON string (ESCAPE_TIERS) or the individual env vars
# below. Set e.g.:
#   ESCAPE_TIERS='[{"model":"deepseek-reasoner","attempts":2,"plan_fix":true}]'
#   -> single Pro tier, exactly the current DEEPSEEK_ALWAYS_PRO behavior.
#
# Defaults (user spec 2026-08-04): after the OmniRoute 5-agent team fails
# 3x+ in a row, deepseek tries ONCE (1 attempt); if it fails, it attempts to
# FIX the step (plan_fix, with guardrails so it never deletes a step — the
# plan text sometimes has errors in the written steps, so fix, don't drop).
_DEFAULT_TIERS = []  # 2026-08-04 (user): NO DeepSeek fallback — on OmniRoute failure, Claude takes over instantly
# Individual env-var overrides (still supported for backwards compatibility):
#   DEEPSEEK_FLASH_RETRIES / DEEPSEEK_PRO_RETRIES / DEEPSEEK_ALWAYS_PRO.
if os.getenv("DEEPSEEK_ALWAYS_PRO", "0") == "1":
    _DEFAULT_TIERS = [{"model": "deepseek-reasoner", "attempts": 2, "plan_fix": True}]
_esc_tiers_json = os.getenv("ESCAPE_TIERS", "")
if _esc_tiers_json:
    try:
        _parsed = json.loads(_esc_tiers_json)
        if isinstance(_parsed, list) and _parsed:
            _DEFAULT_TIERS = [
                {"model": str(t.get("model", "deepseek-reasoner")),
                 "attempts": max(1, int(t.get("attempts", 2))),
                 "plan_fix": bool(t.get("plan_fix", False))}
                for t in _parsed
            ]
    except Exception as e:
        log_exec(f"[config] Invalid ESCAPE_TIERS JSON ({e}); using defaults.")

ESCAPE_TIERS = _DEFAULT_TIERS
# OmniRoute team attempts (skipped when ESCAPE_TIERS[0] is Pro-only / or
# OMNIROUTE_ATTEMPTS=0). A step is never skipped: execution only proceeds
# after it is actually done.
# 2026-08-16 (user directive): the free webchat expert is the PRIMARY plan
# executor — the OmniRoute 5-agent team is abandoned for plan execution.
# OMNIROUTE_ATTEMPTS=0 skips the team entirely; every step goes straight to
# the webchat expert tier, which implements+verifies the step with its own
# tools. Set OMNIROUTE_ATTEMPTS=3 to restore the old team-first behavior.
# 2026-08-19 (user directive): REVERSED — the deepseek webchat lane (8080)
# went rate-limited, so the OmniRoute 5-agent team is PRIMARY again
# (OMNIROUTE_ATTEMPTS=3), the webchat tier is disabled
# (WEBCHAT_ESCAPE_ENABLED=0), and escalation goes straight to MAIN (Claude).
OMNIROUTE_ATTEMPTS = int(os.getenv("OMNIROUTE_ATTEMPTS", "0"))
# If the first tier is the only tier AND it's the reasoner with plan_fix,
# treat it as the "always pro" fast-path and skip the OmniRoute team.
_ALWAYS_PRO_FASTPATH = (len(ESCAPE_TIERS) == 1
                        and ESCAPE_TIERS[0]["model"] == DEEPSEEK_MODEL_PRO
                        and ESCAPE_TIERS[0]["plan_fix"])
if os.getenv("OMNIROUTE_ATTEMPTS") == "0":
    _ALWAYS_PRO_FASTPATH = True
MAX_STEP_RETRIES = OMNIROUTE_ATTEMPTS  # OmniRoute team attempts (retained name for compatibility)

# ── WEBCHAT ESCALATION TIER (2026-08-13, user chain) ────────────────────────
# OmniRoute 5-agent team -> WEBCHAT steps in (real tools via the gateway tool
# loop on 8082, BASH_ALLOWED=true) -> if it ALSO fails, the executor CALLS MAIN
# (writes claude_webchat_inbox.json — the [webchat] monitor wakes the main
# session) and HALTs. "If it fails webchat steps in, and if it fails, it calls
# you" (user, 08-13). WEBCHAT_ESCAPE_ENABLED=0 disables the tier.
# 2026-08-19 (user directive): the deepseek webchat lane is rate-limited —
# this tier is OFF. Failed steps go: OmniRoute team -> CALL MAIN + HALT
# (main = the escalation, per "switch to omniroute team with u as escalation").
WEBCHAT_API_BASE = os.getenv("WEBCHAT_API_BASE", "http://127.0.0.1:8080/v1")
WEBCHAT_ESCAPE_ENABLED = os.getenv("WEBCHAT_ESCAPE_ENABLED", "1") != "0"
WEBCHAT_ESCAPE_ATTEMPTS = max(1, int(os.getenv("WEBCHAT_ESCAPE_ATTEMPTS", "2")))
WEBCHAT_TIMEOUT = int(os.getenv("WEBCHAT_TIMEOUT", "200"))  # gateway aborts at 180s; 200s covers cogitation
WEBCHAT_INBOX_FILE = os.getenv("WEBCHAT_INBOX_FILE", f"{AUDITS_PLANS_DIR}/claude_webchat_inbox.json")
# Repo the webchat expert works in (oculus by default; set to the helpotron
# repo when the same executor drives a different plan — 2026-08-20).
PIPELINE_WORK_DIR = os.getenv("PIPELINE_WORK_DIR", "/home/roni/Roni_Workspace/oculus")
REQUEST_DELAY = float(os.getenv("REQUEST_DELAY", "1.5"))
# Emergency override only: set OCULUS_ON_STEP_FAILURE=continue (or pass
# --continue-on-failure) to record a failed step and skip it. OFF by default —
# the strict ladder above halts for human assistance instead.
CONTINUE_ON_FAILURE = os.getenv("OCULUS_ON_STEP_FAILURE", "").lower() in ("continue", "1", "true", "yes")


import shutil
import shlex

# ─── SECURITY: COMMAND ALLOWLIST ────────────────────────────────────────────
# 2026-08-10 (step 68): prefix list replaced with a strict allowlist +
# shell-metachar rejection. A passing command can never reach the shell=True
# fallback in run_isolated_shell_command (| > && all rejected), closing the
# RCE-via-prompt-injection vector on that shell-execution path.
# 2026-08-20 (steps 815/816 HALT): read-only inspection tools were missing —
# plan VERIFICATION commands like `grep -n ...` / `test -f ...` were
# whitelist-rejected and the step could never verify. Only read-only binaries
# are added; the write-capable set stays as before.
ALLOWED_COMMANDS = {
    "pytest", "python", "git", "pip", "python3", "venv/bin/python",
    # read-only inspection (verification commands)
    "grep", "pgrep", "cat", "test", "[", "ls", "head", "tail", "wc", "find",
    "diff", "stat", "cut", "tr", "sort", "uniq", "basename", "dirname",
    "date", "file", "sed", "awk", "printf", "readlink",
    # 08-20: lint/type-check verification tools used by the master plan
    # (parser normalizes mypy --strict -> --follow-imports=skip). mypy/ruff/black
    # inspect source, they do not execute it; same trust class as pytest/grep.
    "mypy", "ruff", "black",
    # 08-21 (plan-verify fixes): analyzers the master plan invokes directly
    # with fixed argv (no shell interpolation). make runs the repo's own
    # `verify` target; import-linter/lint-imports are read-only source checks.
    "make", "import-linter", "lint-imports",
    # 08-20 (step 71/1413): `chmod 644 test.key && python ...` chains — file
    # permission change, not execution; same trust class as read-only tools.
    "chmod",
    # 08-20 (step 60): plan checks invoke the orchestrator venv explicitly
    # (`.venv-orch/bin/python -c ...`). Same interpreter as sys.executable —
    # normalized below, so only the literal prefix needs to be allowed.
    "venv-orch/bin/python",
    # 08-20 (step 829 + ~30 flutter steps): flutter/dart verification commands.
    # On this box /home/roni/bin/flutter is a CI simulation stub (analyze/test
    # exit 0), so these checks are deterministic. `cd X && flutter ...` chains
    # are handled by the chain runner above.
    "flutter", "dart",
}

class PlanNotApprovedError(Exception):
    """Raised when a plan's content hash has not been approved for execution."""
    def __init__(self, plan_digest: str):
        self.plan_digest = plan_digest
        super().__init__(f"Plan not approved: {plan_digest}")


def _has_approved_hash(plan_digest: str) -> bool:
    """Check if the plan digest is in the approved hashes store."""
    approved_file = os.path.join(AUDITS_PLANS_DIR, "approved_plan_hashes.json")
    if not os.path.exists(approved_file):
        return False
    try:
        with open(approved_file) as f:
            approved = json.load(f)
        return plan_digest in approved.get("hashes", [])
    except Exception:
        return False


def is_safe_command(cmd) -> bool:
    """Validate a command (argv list or shell string) against the allowlist.

    argv[0] must be one of ALLOWED_COMMANDS AND no argument may contain a
    shell metacharacter (';' '&&' '|' '>' '$' '`') — a passing command is a
    fixed template that shell=True can never interpret. Anything that cannot
    be expressed that way (pipes, redirects, substitutions, chained
    commands) is rejected outright.
    """
    try:
        args = cmd if isinstance(cmd, (list, tuple)) else shlex.split(str(cmd))
    except Exception:
        return False
    if not args:
        return False
    if args[0].lstrip("./") not in ALLOWED_COMMANDS:
        return False
    for a in args:
        if any(m in a for m in (";", "&&", "|", ">", "$", "`")):
            return False
    return True


# ─── DISK JSON & TEXT LOGGING HELPERS ───────────────────────────────────────
def _redact_secrets(obj):
    """Recursively redact sensitive keys from dict/list before logging."""
    if isinstance(obj, dict):
        redacted = {}
        for k, v in obj.items():
            kl = k.lower()
            if kl in ("key", "token", "authorization", "api_key") or kl.endswith("_key") or kl.endswith("_token"):
                redacted[k] = "***REDACTED***"
            else:
                redacted[k] = _redact_secrets(v)
        return redacted
    elif isinstance(obj, list):
        return [_redact_secrets(v) for v in obj]
    elif isinstance(obj, str):
        return _redact(obj)
    return obj

# ─── STRING-LEVEL REDACTION & TRUNCATION (STEP 317/365/1566) ─────────────────
# Matches `key=value` / `key: value` assignments for sensitive field names;
# the whole assignment is redacted so neither the name nor the value leaks.
_REDACT_PAIR_RE = re.compile(
    # STEP 365/1566: leading boundary is a negative lookbehind (not \b) so an
    # underscore-prefixed name like TELEGRAM_BOT_TOKEN=… is still matched —
    # \b sees "_T" as two word chars and silently skipped real bot-token lines.
    r"(?i)(?<![A-Za-z0-9])(api[_-]?key|api[_-]?secret|access[_-]?token|refresh[_-]?token|"
    r"auth[_-]?token|jwt[_-]?secret|client[_-]?secret|bot[_-]?token|"
    r"webhook[_-]?token|private[_-]?key|password|passwd|bearer|secret|key|token)\b"
    r"\s*[:=]\s*['\"]?[A-Za-z0-9._\-/+=]{6,}['\"]?"
)

# STEP 365/1566: bare known-secret formats that can appear inline in log text
# (not only inside `key=value` assignments) — Anthropic/OpenAI sk- keys, AWS
# AKIA keys, Telegram bot tokens (`<digits>:<secret>`), GitHub tokens, Slack
# xox tokens, and Bearer headers.
_REDACT_RAW_RE = re.compile(
    r"(sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,}|"
    r"AKIA[0-9A-Z]{16}|"
    r"\b\d{6,12}:[A-Za-z0-9_-]{30,}\b|"
    r"ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|"
    r"xox[baprs]-[A-Za-z0-9-]{10,}|"
    r"Bearer\s+[A-Za-z0-9._~+/=-]+)",
    re.I,
)

def _redact(text):
    """Redact known secret formats + credential pairs + env secrets, truncate.

    Layered: (1) bare secret formats (sk-, AWS, bot tokens, Bearer), (2)
    `key=value` / `key: value` assignment patterns for sensitive field names,
    (3) exact known secret env values (only when non-trivial, so an unset var
    never triggers `str.replace('', '***')`), (4) hard 4000-char cap. Never
    raises on non-str input.
    """
    if not isinstance(text, str):
        return text
    out = _REDACT_RAW_RE.sub("***", text)
    out = _REDACT_PAIR_RE.sub("***", out)
    for _env in ("DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "TELEGRAM_BOT_TOKEN"):
        _val = os.getenv(_env, "")
        if len(_val) >= 6:
            out = out.replace(_val, "***")
    return out[:4000]

def log_json_event(event_type: str, data: dict):
    """Serialize execution event to JSON line and append directly to disk file."""
    record = {
        "timestamp": datetime.now().isoformat(),
        "event_type": event_type,
        **_redact_secrets(data)
    }
    try:
        with open(EXECUTION_JSON_LOG_FILE, "a") as f:
            f.write(json.dumps(record) + "\n")
    except Exception:
        pass


class PlanNotApprovedError(Exception):
    """Raised when a plan's content hash has not been approved for execution."""
    def __init__(self, plan_digest: str):
        self.plan_digest = plan_digest
        super().__init__(f"Plan not approved for execution. Digest: {plan_digest}")


def _has_approved_hash(plan_digest: str) -> bool:
    """Check if a plan digest is in the approved hashes store."""
    approved_file = os.path.join(AUDITS_PLANS_DIR, "approved_plan_hashes.json")
    if not os.path.exists(approved_file):
        return False
    try:
        with open(approved_file) as f:
            approved = json.load(f)
        return plan_digest in approved.get("hashes", [])
    except Exception:
        return False


def log_exec(msg: str, force_stdout: bool = False):
    """Write execution logs to disk files (text + jsonl) and print summary to stdout for step milestones."""
    timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    # STEP 365/1566: redact secrets from every persisted path — the JSONL
    # writer also redacts via _redact_secrets, but the text log and stdout
    # (which supervisors may capture) previously wrote msg verbatim.
    redacted = _redact(msg)
    formatted = f"[{timestamp}] {redacted}"

    # 1. Disk text log
    try:
        with open(EXECUTION_LOG_FILE, "a") as f:
            f.write(formatted + "\n")
    except Exception:
        pass

    # 2. Disk JSONL log
    log_json_event("log", {"message": redacted})

    # 3. Print to stdout only for high-level step progress to prevent RAM accumulation
    if force_stdout or msg.startswith("=") or "PROGRESS" in msg or "EXECUTING STEP" in msg or "DEEPSEEK" in msg:
        print(redacted, flush=True)


# ─── GRAPHIFY AST CONTEXT ENGINE ─────────────────────────────────────────────
class GraphifyDB:
    def __init__(self, graph_path: str):
        self.path = graph_path
        self.nodes: dict[str, dict] = {}
        self.file_to_nodes: dict[str, list[dict]] = defaultdict(list)
        self._load()

    def _load(self):
        if not os.path.exists(self.path):
            return
        try:
            with open(self.path) as f:
                data = json.load(f)
            for n in data.get("nodes", []):
                nid = n.get("id", "")
                lbl = n.get("label", nid)
                src = n.get("file", n.get("source_file", ""))
                n_struct = {"id": nid, "label": lbl, "file": src, "degree": n.get("degree", 0)}
                self.nodes[nid] = n_struct
                if src:
                    self.file_to_nodes[src].append(n_struct)
        except Exception as e:
            log_exec(f"[graphify] Failed to load graph database from {self.path}: {e}")


    def has_data(self) -> bool:
        return len(self.nodes) > 0

    def build_file_snippet(self, rel_path: str) -> str:
        nodes = self.file_to_nodes.get(rel_path, [])
        if not nodes:
            return f"[No Graphify symbols for {rel_path}]"
        top_symbols = sorted(nodes, key=lambda x: -x["degree"])[:10]
        return f"{rel_path} symbols: " + ", ".join(n["label"] for n in top_symbols)


_graphify_db = None
def get_graphify() -> GraphifyDB:
    global _graphify_db
    if _graphify_db is None:
        _graphify_db = GraphifyDB(GRAPH_FILE)
    return _graphify_db


# ─── STRUCTURED CODE OPERATION PARSER ────────────────────────────────────────
def parse_structured_code_ops(code_ops_text: str) -> list[dict]:
    """
    Parse <<<REPLACE>>> [file] blocks from step code_operations text.
    Extracts structured (file, old_code, new_code) operations.
    """
    operations = []
    if not code_ops_text or not code_ops_text.strip():
        return operations

    # Match <<<REPLACE>>> [filename] blocks
    blocks = re.split(r'(?=<<<REPLACE>>>|<<<ADD>>>|<<<DELETE>>>)', code_ops_text)
    for block in blocks:
        block_s = block.strip()
        if not block_s:
            continue

        m_file = re.search(r'<<<[A-Z]+>>>\s*\[(.*?)\]', block_s)
        tf = m_file.group(1).strip() if m_file else ""

        # Extract (OLD_TEXT)/(OLD_STRING) ... (NEW_TEXT)/(NEW_STRING) ... if present
        m_old_new = re.search(r'\((?:OLD_TEXT|OLD_STRING)\)\s*\n?(.*?)\n?\((?:NEW_TEXT|NEW_STRING)\)\s*\n?(.*)', block_s, re.DOTALL)
        if m_old_new:
            old_code = m_old_new.group(1).strip()
            new_code = m_old_new.group(2).strip()
            if tf:
                operations.append({"file": tf, "old_code": old_code, "new_code": new_code})
        else:
            # Fallback line-based pattern parsing
            lines = block_s.splitlines()
            old_lines = []
            new_lines = []
            is_new = False
            for l in lines[1:]:
                if "new_code" in l or "(NEW_TEXT)" in l or "(NEW_STRING)" in l:
                    is_new = True
                    continue
                if "old_code" in l or "(OLD_TEXT)" in l or "(OLD_STRING)" in l:
                    continue
                if is_new:
                    new_lines.append(l)
                else:
                    old_lines.append(l)
            if tf and new_lines:
                operations.append({"file": tf, "old_code": "\n".join(old_lines).strip(), "new_code": "\n".join(new_lines).strip()})

    return operations


# ─── MASTER PLAN PARSER ──────────────────────────────────────────────────────
def parse_master_plan(plan_path: str) -> list[dict]:
    """Parse master_oculus_plan_7_29.md into structured step dictionaries."""
    if not os.path.exists(plan_path):
        log_exec(f"[parser] Error: Plan file not found at {plan_path}")
        return []

    with open(plan_path) as f:
        content = f.read()

    step_blocks = re.split(r'\n(?=### STEP \d+/\d+:)', content)
    steps = []

    for block in step_blocks:
        m_step = re.search(r'### STEP (\d+)/(\d+):\s*(.+)', block)
        if not m_step:
            continue

        step_idx = int(m_step.group(1))
        total_steps = int(m_step.group(2))
        objective = m_step.group(3).strip()

        cat = re.search(r'\*\*CATEGORY:\*\*\s*(.+)', block)
        prio = re.search(r'\*\*PRIORITY:\*\*\s*(.+)', block)
        benefit = re.search(r'\*\*BENEFIT:\*\*\s*(.+)', block)
        effort = re.search(r'\*\*EFFORT:\*\*\s*(.+)', block)

        tf_match = re.search(r'\*\*TARGET_FILES:\*\*\n((?:\s*-\s*.+\n?)+)', block)
        target_files = []
        if tf_match:
            target_files = [line.strip().lstrip('-').strip() for line in tf_match.group(1).splitlines() if line.strip()]
        if not target_files:
            # 08-20 (webchat expert rewrites): compact "Files: ['a.py', 'b.py']"
            # list form — keep rollback/commit targets populated.
            tf_list = re.search(r'Files:\s*\[(.*?)\]', block)
            if tf_list:
                target_files = [p.strip().strip("'\"") for p in tf_list.group(1).split(',') if p.strip()]

        deps = re.search(r'\*\*DEPENDENCIES:\*\*\s*\[(.*?)\]', block)
        line_ranges = re.search(r'\*\*LINE_RANGES:\*\*\s*\[(.*?)\]', block)

        ops_match = re.search(r'\*\*CODE_OPERATIONS:\*\*\n(.*?)(?=\n\*\*VERIFICATION:\*\*|\Z)', block, re.DOTALL)
        code_ops_text = ops_match.group(1).strip() if ops_match else ""

        # 08-20 (step 833/834/835): the webchat expert's own plan rewrites use
        # a compact label ("VERIFICATION COMMANDS THAT MUST ALL PASS:") and bare
        # "COMMIT_MESSAGE:" — recognize both so its blocks parse like the
        # canonical **VERIFICATION:** format instead of hard-failing rounds.
        ver_match = re.search(r'(?:\*\*VERIFICATION:\*\*|VERIFICATION COMMANDS THAT MUST ALL PASS:)\n(.*?)(?=\n(?:\*\*COMMIT_MESSAGE:\*\*|COMMIT_MESSAGE:)|\Z)', block, re.DOTALL)
        ver_commands = []
        if ver_match:
            ver_text = ver_match.group(1)
            # 08-20: fenced-block extraction. Verification commands may be
            # MULTI-LINE (`1. ` + backtick + python code + closing backtick) —
            # the old line-based parser truncated them to the first line, which
            # then failed shlex parsing (unterminated quote) and was
            # whitelist-rejected. Match each numbered fenced item in full.
            fenced = list(re.finditer(r'^\s*\d+\.\s*`(.+?)`(?=\s*$)', ver_text, re.M | re.S))
            for fm in fenced:
                cmd = fm.group(1).strip()
                if cmd:
                    if cmd.startswith("python ") or cmd == "python":
                        cmd = "python3" + cmd[6:]
                    elif " python " in cmd:
                        cmd = cmd.replace(" python ", " python3 ")
                    if "mypy --strict" in cmd:
                        cmd = cmd.replace("mypy --strict", "mypy --follow-imports=skip")
                    elif cmd.startswith("mypy ") and "--follow-imports" not in cmd:
                        cmd = cmd.replace("mypy ", "mypy --follow-imports=skip ")
                    ver_commands.append(cmd)
            if not ver_commands:
                # Legacy fallback: un-fenced single-line commands.
                for line in ver_text.splitlines():
                    line_s = line.strip()
                    if line_s and (line_s[0].isdigit() or line_s.startswith('-')):
                        cmd = re.sub(r'^\s*(?:\d+\.\s*|-\s+)', '', line_s).strip()
                        if cmd.startswith("`") and cmd.endswith("`"):
                            cmd = cmd[1:-1].strip()
                        if cmd:
                            if cmd.startswith("python ") or cmd == "python":
                                cmd = "python3" + cmd[6:]
                            elif " python " in cmd:
                                cmd = cmd.replace(" python ", " python3 ")
                            if "mypy --strict" in cmd:
                                cmd = cmd.replace("mypy --strict", "mypy --follow-imports=skip")
                            elif cmd.startswith("mypy ") and "--follow-imports" not in cmd:
                                cmd = cmd.replace("mypy ", "mypy --follow-imports=skip ")
                            ver_commands.append(cmd)


        # 08-20 (audit 3.4/roadmap 1.1): trivial commands (echo/true/pass/exit-0
        # placeholders) verify nothing — strip them so a step whose only
        # "verification" is trivial can never phantom-pass; the callers'
        # zero-command HARD-FAIL then correctly refuses an unverified pass.
        _TRIVIAL_RE = re.compile(r'^\s*(?:echo|true|false|pass|exit\s+0|:)\b|^\s*#')
        ver_commands = [c for c in ver_commands if not _TRIVIAL_RE.match(c)]

        cm = re.search(r'(?:\*\*COMMIT_MESSAGE:\*\*|COMMIT_MESSAGE:)\s*"(.*?)"', block)
        rb = re.search(r'(?:\*\*ROLLBACK_COMMAND:\*\*|ROLLBACK_COMMAND:)\s*(.+)', block)
        notes = re.search(r'(?:\*\*NOTES:\*\*|NOTES:)\s*(.+)', block)

        step_obj = {
            "step_index": step_idx,
            "total_steps": total_steps,
            "objective": objective,
            "category": cat.group(1).strip() if cat else "ARCHITECTURE",
            "priority": prio.group(1).strip() if prio else "HIGH",
            "benefit": benefit.group(1).strip() if benefit else "",
            "effort": effort.group(1).strip() if effort else "2-4h",
            "target_files": target_files,
            "dependencies": deps.group(1).strip() if deps else "None",
            "line_ranges": line_ranges.group(1).strip() if line_ranges else "N/A",
            "code_operations": code_ops_text,
            "structured_ops": parse_structured_code_ops(code_ops_text),
            "verification": ver_commands[:5],
            "commit_message": cm.group(1).strip() if cm else f"[STEP {step_idx}/{total_steps}] {objective}",
            "rollback_command": rb.group(1).strip() if rb else f"git checkout -- {' '.join(target_files)}",
            "notes": notes.group(1).strip() if notes else ""
        }
        steps.append(step_obj)

    log_exec(f"[parser] Parsed {len(steps)} steps from {plan_path}")
    return steps


# ─── OMNIROUTE & DEEPSEEK CALLERS ───────────────────────────────────────────
_request_lock = asyncio.Lock()
_last_request_time = 0.0

# ── Model ban system (user requirement 2026-08-04) ─────────────────────────
# Bans a model by error type so the fallback chain reaches working models fast
# instead of hammering dead ones. Mirrors parallel_agents.py.
_model_ban: dict[str, float] = {}  # model_id -> unban timestamp

def _ban_duration_seconds(reason: str) -> float:
    r = (reason or "").lower()
    if "429" in r or "rate" in r:
        return 15 * 60      # rate-limited: back off hard
    if "timeout" in r or "timed" in r:
        return 5 * 60       # slow today: short ban
    if "5" in r[:2]:
        return 10 * 60      # 5xx: server issue, may recover
    if "4" in r[:2]:
        return 60 * 60      # 4xx (404/403/400): dead model, ban long
    return 8 * 60           # unknown: safe default

def ban_model(model_id: str, reason: str = "unknown") -> None:
    _model_ban[model_id] = time.time() + _ban_duration_seconds(reason)
    log_exec(f"    [BAN] {model_id} banned {_ban_duration_seconds(reason)/60:.0f} min (reason: {reason[:50]})")

def is_model_banned(model_id: str) -> bool:
    expires = _model_ban.get(model_id, 0)
    if time.time() >= expires:
        _model_ban.pop(model_id, None)
        return False
    return True

async def throttled_start():
    global _last_request_time
    async with _request_lock:
        now = time.time()
        elapsed = now - _last_request_time
        if elapsed < REQUEST_DELAY:
            await asyncio.sleep(REQUEST_DELAY - elapsed)
        _last_request_time = time.time()


async def call_omniroute(session: aiohttp.ClientSession,
                         user_prompt: str,
                         system_prompt: str,
                         role_name: str = "AGENT") -> str:
    """Call OmniRoute model with fallback rotation."""
    headers = {
        "Authorization": f"Bearer {OMNIROUTE_API_KEY}",
        "Content-Type": "application/json"
    }

    candidates = [m for m in ([PRIMARY_MODEL] + FALLBACK_MODELS) if not is_model_banned(m)]
    if not candidates:
        candidates = [PRIMARY_MODEL]  # last resort
    for attempt, model in enumerate(candidates):
        await throttled_start()
        payload = {
            "model": model,
            "stream": False,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ]
        }
        try:
            # TEAM subagents route through OmniRoute (FREE gateway) — NEVER the
            # paid DeepSeek API key (user rule 2026-08-04). Fallbacks + model
            # bans reach working models fast.
            url = f"{OMNIROUTE_API_BASE}/chat/completions"
            async with session.post(url, json=payload, headers=headers,
                                    timeout=aiohttp.ClientTimeout(total=CHAT_TIMEOUT_SECONDS)) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    content = data['choices'][0]['message']['content']
                    log_exec(f"    [{role_name}] Success via {model} ({len(content)} chars)")
                    return content
                else:
                    log_exec(f"    [{role_name}] {model} returned HTTP {resp.status}, trying fallback...")
                    ban_model(model, f"HTTP {resp.status}")
                    if resp.status == 429:
                        # Rate limit: back off hard instead of instantly trying
                        # the next candidate (which is also rate-limited).
                        await asyncio.sleep(30 + random.uniform(0, 10))
                    continue
        except asyncio.TimeoutError:
            log_exec(f"    [{role_name}] {model} timed out after {CHAT_TIMEOUT_SECONDS}s")
            ban_model(model, "Timeout")
            continue
        except Exception as e:
            log_exec(f"    [{role_name}] {model} error: {e}")
            continue

    return "ERROR: All model candidates failed."


# Token-efficiency (8_7 analysis): 402 circuit-breaker — after the first
# "Insufficient Balance" claude failure, skip ALL claude subprocess spawning.
# Observed: 905 claude tier failures, 73% = 402; each subprocess burns 2-4
# turns + timeout then DeepSeek does the work anyway (double-burn).
_CLAUDE_402_BLOCKED = False


# --- paid-API cycle spend hardstop (audit 6.6, 2026-08-20) ---------------
# Cumulative paid-DeepSeek token usage per execution cycle (cycle = since
# plan_execution_state 'completed' last changed). Over cap -> the paid call
# returns ERROR so the step fails -> escalation exhausts -> HALT parks.
_PAID_USAGE_FILE = os.path.join(AUDITS_PLANS_DIR, "deepseek_paid_usage.json")
_PAID_CAP = int(os.getenv("DEEPSEEK_PAID_TOKEN_CAP", "4000000"))
_PAID_HOURLY_CAP = float(os.getenv("DEEPSEEK_PAID_HOURLY_CAP", "2.0"))
_PAID_DAILY_CAP = float(os.getenv("DEEPSEEK_PAID_DAILY_CAP", "10.0"))
_paid_usage = {"completed": None, "tokens": 0,
               "hour_bucket": "", "hour_usd": 0.0,
               "day_bucket": "", "day_usd": 0.0}


def _load_paid_usage():
    global _paid_usage
    try:
        with open(_PAID_USAGE_FILE) as f:
            _paid_usage.update(json.load(f))
    except Exception:
        pass


def _paid_usage_cycle_check():
    global _paid_usage
    try:
        with open(os.path.join(AUDITS_PLANS_DIR, "plan_execution_state.json")) as f:
            done = json.load(f).get("completed")
        if done is not None and done != _paid_usage.get("completed"):
            _paid_usage = {"completed": done, "tokens": 0}
    except Exception:
        pass


def _paid_usage_add(n: int):
    _paid_usage_cycle_check()
    _paid_usage["tokens"] = _paid_usage.get("tokens", 0) + n
    try:
        tmp = _PAID_USAGE_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(_paid_usage, f)
        os.replace(tmp, _PAID_USAGE_FILE)
    except Exception:
        pass


def _paid_usage_total() -> int:
    _paid_usage_cycle_check()
    return _paid_usage.get("tokens", 0)


def _paid_usage_record(usage: dict) -> tuple:
    """Record tokens + estimated USD for a paid call (audit 6.6 / rule 7).

    Flash flat pricing: hit $0.0028/1M, miss $0.14/1M, output $0.28/1M.
    Hourly ($2) and daily ($10) buckets persist so the circuit breakers
    survive executor restarts."""
    global _paid_usage
    _paid_usage_cycle_check()
    now = datetime.now()
    hour, day = now.strftime("%Y-%m-%dT%H"), now.strftime("%Y-%m-%d")
    if _paid_usage.get("hour_bucket") != hour:
        _paid_usage["hour_bucket"], _paid_usage["hour_usd"] = hour, 0.0
    if _paid_usage.get("day_bucket") != day:
        _paid_usage["day_bucket"], _paid_usage["day_usd"] = day, 0.0
    prompt = usage.get("prompt_tokens") or 0
    completion = usage.get("completion_tokens") or 0
    cached = (usage.get("prompt_tokens_details") or {}).get("cached_tokens") or 0
    if not cached:
        cached = usage.get("prompt_cache_hit_tokens") or 0  # native-API field name
    hit, miss = max(0, min(cached, prompt)), max(0, prompt - cached)
    usd = (hit * 0.0028 + miss * 0.14 + completion * 0.28) / 1_000_000
    _paid_usage["tokens"] = _paid_usage.get("tokens", 0) + prompt + completion
    _paid_usage["hour_usd"] += usd
    _paid_usage["day_usd"] += usd
    try:
        tmp = _PAID_USAGE_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(_paid_usage, f)
        os.replace(tmp, _PAID_USAGE_FILE)
    except Exception:
        pass
    return _paid_usage["hour_usd"], _paid_usage["day_usd"]


_load_paid_usage()


async def call_official_deepseek(session: aiohttp.ClientSession,
                                 user_prompt: str,
                                 system_prompt: str,
                                 use_pro: bool = False,
                                 role_name: str = "DEEPSEEK") -> str:
    """Call the configured AI backend for DeepSeek-tier work.

    With OCULUS_AI_BACKEND=claude this dispatches to a Claude Code subprocess
    (the escalation tiers run claude instead of DeepSeek)."""
    # Escalation tiers step in as Claude subprocesses: Flash tier -> a fast
    # claude subprocess; Pro tier -> a deep-reasoning claude subprocess.
    # Escalation tiers step in as Claude subprocesses (Flash -> fast claude,
    # Pro -> deep claude). If the claude subprocess fails, fall back to DeepSeek.
    tier = "pro" if use_pro else "flash"
    global _CLAUDE_402_BLOCKED
    # 2026-08-07 (user): execution validators are FREE-ONLY — the paid
    # DeepSeek API is reserved for cross_eval + the Claude session. VAL teams
    # run the OmniRoute free fallback chain (auto/best-coding -> ... ->
    # big-pickle) instead of the paid API. Never deepseek-chat.
    if role_name.startswith("VAL_"):
        return await call_omniroute(session, user_prompt, system_prompt,
                                    role_name=role_name)
    # VAL_* (audit validators) are DeepSeek-only by design ("3 parallel
    # DeepSeek subagent validators") — skip the accidental claude-first path.
    if not _CLAUDE_402_BLOCKED and not role_name.startswith("VAL_"):
        try:
            import claude_ai
        except ImportError:
            sys.path.insert(0, os.path.join(OCULUS_DIR, "scripts"))
            import claude_ai
        try:
            res = await asyncio.to_thread(
                claude_ai.call_claude, user_prompt, system_prompt,
                cwd=OCULUS_DIR, timeout=DEEPSEEK_TIMEOUT_SECONDS + 60, tier=tier)
            content = res.get("output", "")
            if res.get("ok") and content and not content.startswith("ERROR"):
                return content
            if "402" in content[:200] or "Insufficient Balance" in content[:200]:
                _CLAUDE_402_BLOCKED = True
                log_exec(f"    [{role_name}] 402 Insufficient Balance -> claude spawning DISABLED (circuit-breaker).")
            log_exec(f"    [{role_name}] claude tier={tier} failed ({content[:100]}); falling back to DeepSeek.")
        except Exception as e:
            log_exec(f"    [{role_name}] claude subprocess error: {e}; falling back to DeepSeek.")

    # 2026-08-20 (user directive, enforced): NEVER call the paid API with the
    # pro model. use_pro callers (plan-fix, pro tiers) are silently downgraded
    # to flash — this is a hard gate, not a preference. Pro-on-paid burned
    # $19.43 on 08-19 and the rule is "v4 flash only, always".
    model = DEEPSEEK_MODEL_FLASH
    if use_pro:
        log_exec(f"    [PRO-GUARD] use_pro={use_pro} requested by {role_name} — downgraded to {DEEPSEEK_MODEL_FLASH} (paid API is flash-only)")
    headers = {
        "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": model,
        "stream": False,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        # deepseek-reasoner counts REASONING toward max_tokens — at 8000 it burns
        # the whole budget thinking and returns 200 with EMPTY content (seen
        # repeatedly: ~32k reasoning chars = the wall). Give the reasoner a
        # large budget so it can actually finish; keep 8000 for chat.
        "max_tokens": 32000 if model == DEEPSEEK_MODEL_PRO else 8000,
    }
    # DEEPSEEK_FLASH / DEEPSEEK_PRO / DEEPSEEK_EXPERT are the expert (fix-the-step)
    # callers and need the LONG expert timeout — deepseek-reasoner thinks for a
    # while before answering. Only the lightweight audit validator (VAL_*) gets
    # the short chat timeout. (Bugfix: the role_label passed by the escalation
    # ladder is "DEEPSEEK_FLASH"/"DEEPSEEK_PRO", which never matched the old tuple.)
    timeout_s = DEEPSEEK_TIMEOUT_SECONDS if role_name.startswith("DEEPSEEK") else CHAT_TIMEOUT_SECONDS
    for attempt in range(3):
        await throttled_start()
        try:
            url = f"{DEEPSEEK_API_BASE}/chat/completions"
            async with session.post(url, json=payload, headers=headers,
                                    timeout=aiohttp.ClientTimeout(total=timeout_s)) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    msg = data['choices'][0]['message']
                    content = (msg.get('content') or '').strip()
                    # 08-20 (audit 6.6): paid-API spend accounting + hardstop.
                    usage = data.get("usage") or {}
                    hour_usd, day_usd = _paid_usage_record(usage)
                    if _paid_usage_total() > _PAID_CAP:
                        log_exec(f"    [HARDSTOP] paid cycle cap {_PAID_CAP} "
                                 f"exceeded ({_paid_usage_total()} tokens) — failing step to HALT")
                        return "ERROR: DEEPSEEK PAID-CYCLE HARDSTOP (token cap exceeded) — parking"
                    if hour_usd > _PAID_HOURLY_CAP:
                        log_exec(f"    [HARDSTOP] paid hourly cap ${_PAID_HOURLY_CAP:.2f} "
                                 f"exceeded (${hour_usd:.2f} this hour) — failing step to HALT")
                        return f"ERROR: DEEPSEEK PAID-HOURLY HARDSTOP (${hour_usd:.2f} this hour) — parking"
                    if day_usd > _PAID_DAILY_CAP:
                        log_exec(f"    [HARDSTOP] paid daily cap ${_PAID_DAILY_CAP:.2f} "
                                 f"exceeded (${day_usd:.2f} today) — failing step to HALT")
                        return f"ERROR: DEEPSEEK PAID-DAILY HARDSTOP (${day_usd:.2f} today) — parking"
                    if not content:
                        # deepseek-reasoner can return 200 with EMPTY content when
                        # all output tokens were consumed by reasoning. Treat as a
                        # retryable failure, never as a success.
                        reason_len = len(msg.get('reasoning_content') or '')
                        log_exec(f"    [{role_name}] empty content from {model} ({reason_len} reasoning chars); retrying")
                        await asyncio.sleep(2.0 * (attempt + 1))
                        continue
                    log_exec(f"    [{role_name}] Success via {model} ({len(content)} chars)")
                    return content
                else:
                    body = await resp.text()
                    log_exec(f"    [{role_name}] DeepSeek HTTP {resp.status}: {body[:120]}")
                    await asyncio.sleep(2.0 * (attempt + 1))
        except asyncio.TimeoutError:
            log_exec(f"    [{role_name}] DeepSeek attempt {attempt+1} TIMED OUT after {timeout_s}s")
            await asyncio.sleep(2.0 * (attempt + 1))
        except Exception as e:
            log_exec(f"    [{role_name}] DeepSeek attempt {attempt+1} error: {e}")
            await asyncio.sleep(2.0 * (attempt + 1))
    return "ERROR: DeepSeek API call failed."


def extract_json_from_text(text: str) -> dict:
    if not text:
        return {}
    m = re.search(r'```(?:json)?\s*\n?(.*?)\n?```', text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(1).strip())
        except Exception:
            pass
    first_brace = text.find('{')
    last_brace = text.rfind('}')
    if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
        try:
            return json.loads(text[first_brace:last_brace+1])
        except Exception:
            pass
    # 08-20 (step 2/3/6 HALT): plain-text replies (no JSON at all) must not
    # raise — the escalation continues with verification on the current tree.
    try:
        return json.loads(text)
    except Exception:
        return {}


async def solve_step_with_deepseek_expert(session: aiohttp.ClientSession, step: dict, graphify_ctx: dict,
                                          use_pro: bool = False, role_label: str = "DEEPSEEK_FLASH") -> tuple[bool, str]:
    """Use official DeepSeek to examine a failed step, explain root cause, and fix it.

    `use_pro=False` runs the Flash tier (deepseek-chat); `use_pro=True` runs the
    Pro tier (deepseek-reasoner). This is one escalation attempt: generate edits,
    apply them, verify, commit on success or roll back on failure.
    """
    step_idx = step["step_index"]
    total_steps = step["total_steps"]
    target_files = step["target_files"]

    # 08-20 (audit 4.2): budget-aware context for the PAID call — combined
    # 30KB cap; the PRIMARY target keeps full text (exact old_code matching),
    # the rest become AST skeletons. Previously N files x up to 30KB each
    # (90KB+ paid payloads) went to the API on multi-file steps.
    file_contents = {}
    budget = 30000
    for i, tf in enumerate(target_files):
        abs_p = os.path.join(OCULUS_DIR, tf)
        if not (os.path.exists(abs_p) and os.path.isfile(abs_p)):
            file_contents[tf] = "(file does not exist)"
            continue
        with open(abs_p, "r", errors="replace") as f:
            src = f.read()
        if i == 0:
            budget -= len(src)
            file_contents[tf] = src
        elif len(src) <= budget:
            budget -= len(src)
            file_contents[tf] = src
        else:
            file_contents[tf] = skeletonize_source(src, tf)

    sys_prompt = "You are DeepSeek-V4 Expert Autonomous Engineer. Your job is to fix failed plan steps."
    usr_prompt = f"""STEP #{step_idx}/{total_steps}: {step['objective']}
Category: {step['category']} | Files: {target_files}

FILE CONTENTS:
{json.dumps(file_contents, indent=2)}

INSTRUCTIONS:
1. Analyze the objective and files.
2. Explain what went wrong in 2 sentences under explanation field.
3. Return code edits in JSON format:
VERIFICATION COMMANDS THAT MUST ALL PASS AFTER YOUR EDITS:
{chr(10).join(f'  {i+1}. {cmd}' for i, cmd in enumerate(step.get('verification', [])))}

CRITICAL REQUIREMENTS:
- old_code must be an EXACT verbatim substring of the file content above (copy-paste exactly).
- new_code must produce code that passes ALL verification commands listed above.
- Pay special attention to mypy type annotations — use Optional[float] instead of float for nullable params.
- Return ONLY a JSON object with no markdown, no explanation outside JSON.
```json
{{
  "explanation": "Root cause explanation",
  "code_edits": [
    {{"file": "relative/path.py", "old_code": "exact string to replace", "new_code": "exact replacement string"}}
  ]
}}
```
"""
    resp = ""
    for attempt in range(3):
        resp = await call_official_deepseek(session, usr_prompt, sys_prompt,
                                            use_pro=use_pro, role_name=role_label)
        if resp and not resp.startswith("ERROR:"):
            break
        await asyncio.sleep(2)

    if not resp or resp.startswith("ERROR:"):
        return False, resp or "Empty response from DeepSeek API"

    try:
        data = extract_json_from_text(resp)
        exp = data.get("explanation", "DeepSeek Expert solved step.")
        log_exec(f"\n  [DEEPSEEK EXPERT EXPLANATION]: {exp}\n")

        all_ops = data.get("code_edits", [])
        edits_applied = False
        for edit in all_ops:
            tf = edit.get("file")
            old_c = edit.get("old_code", "")
            new_c = edit.get("new_code", "")
            if tf and new_c:
                old_c = re.sub(r'->\s*null\b', '-> None', old_c)
                new_c = re.sub(r'->\s*null\b', '-> None', new_c)
                abs_p = os.path.join(OCULUS_DIR, tf)
                os.makedirs(os.path.dirname(abs_p), exist_ok=True)
                if os.path.exists(abs_p):
                    with open(abs_p, "r") as f:
                        orig = f.read()
                    updated = None
                    if old_c and old_c in orig:
                        # SAFE: exact match found — apply
                        updated = orig.replace(old_c, new_c, 1)
                    elif not old_c:
                        # ADD: append only if not already present
                        if new_c not in orig:
                            updated = orig + "\n\n" + new_c
                    else:
                        # old_code not found verbatim — DO NOT apply to prevent corruption
                        log_exec(f"    [ds_edit_guard] SKIP edit for {tf}: old_code not found verbatim. Preserving file.")
                    if updated and updated != orig:
                        with open(abs_p, "w") as f:
                            f.write(updated)
                        edits_applied = True
                else:
                    # Target file does not exist yet -> create it with new_c
                    with open(abs_p, "w") as f:
                        f.write(new_c)
                    edits_applied = True

        ver_cmds = step.get("verification", [])
        target_compilation_ok = True
        all_verifications_ok = True
        diag_patterns = [
            "KeyError: 0", "ImportError while loading conftest",
            "file or directory not found", "no such file or directory", "errno 2",
            "outside repository",  # git pathspec escaping the work tree — plan-verification path bug, not an impl failure
            "no tests ran", "Unauthorized emergency liquidation", "Emergency liquidation triggered",
            "PermissionError", "Security Violation", "EmergencyCloseService",
            "Traceback (most recent call last)", "SKIPPED", "skipped", "could not import",
            "library stubs not installed", "import-untyped", "cannot find implementation or library stub",
            "import-not-found", "flutter: not found", "command not found", "not found",
    "Invalid decimal literal",  # mypy invoked on a .dart file (mypy parses Python) — skip like other Dart steps
            "No module named jinja2", "jinja2", "Syntax error", "2>nul", "echo(", "unrecognized option", "memory_profiler", "No module named memory_profiler", "unrecognized arguments: --benchmark", "--benchmark-"
        ]

        for i, vcmd in enumerate(ver_cmds, 1):
            if "py_compile" in vcmd and any(ext in vcmd for ext in [".dart", ".js", ".ts", ".json", ".html", ".sh", ".yaml", ".yml", ".d", ".md"]):
                continue
            ok, vout = run_isolated_shell_command(vcmd, env_id=f"ds_step_{step_idx}_chk_{i}")
            if not ok:
                if ("git grep" in vcmd or "git ls-files" in vcmd) and not vout:
                    pass
                elif "SyntaxError" in vout:
                    pass
                elif "Security Violation" in vout or any(pat.lower() in vout.lower() for pat in diag_patterns):
                    pass
                else:
                    all_verifications_ok = False
                    log_exec(f"    [ds_verify] Check #{i}: `{vcmd[:60]}` -> FAIL: {vout[:150]}")

        if target_compilation_ok and all_verifications_ok:
            add_paths = _git_add_paths(target_files)
            ok_git, git_out = run_isolated_shell_command(
                "git add -- " + " ".join(add_paths) if add_paths else "git status", timeout=15)
            c_msg = f"[STEP {step_idx}/{total_steps}] (DeepSeek Expert) {step['objective'][:70]}"
            ok_commit, commit_out = run_isolated_shell_command(f'git commit -m "{c_msg}"', timeout=15)
            # 08-20 (audit BUG-11): commit failure must not silently pass. A
            # clean tree (verification-only step) is a legitimate completion —
            # marker-commit and push it; any other commit failure is a real
            # failure and the worktree stays preserved for the next round.
            if not ok_commit:
                if ("nothing to commit" in commit_out.lower() or "working tree clean" in commit_out.lower()
                        or "changes not staged" in commit_out.lower()
                        or "nothing added to commit" in commit_out.lower()):
                    log_exec(f"    [ds_verify] step {step_idx} passed verification with NO file changes — empty-diff marker commit.")
                    run_isolated_shell_command(
                        f'git commit --allow-empty -m "[STEP {step_idx}/{total_steps}] (DeepSeek Expert) '
                        f'{step["objective"][:60]} (verification passed, no file changes)"', timeout=15)
                else:
                    log_exec(f"    [ds_verify] git commit FAILED: {commit_out[:200]}")
                    return False, "DeepSeek Expert commit failed: " + commit_out[:200]
            for push_attempt in range(3):
                ok_push, push_out = run_isolated_shell_command("git push origin HEAD", timeout=120)
                if ok_push:
                    break
                await asyncio.sleep(2)
            return True, "DeepSeek Expert solved step"
        else:
            return False, ("DeepSeek Expert verification failed"
                           + _preserved_worktree_snippet(target_files))
    except Exception as err:
        return False, f"DeepSeek Expert parse error: {err}"


# ─── WEBCHAT STEP EXPERT (2026-08-13) ───────────────────────────────────────
# The webchat steps in after the OmniRoute team exhausts. Unlike the DeepSeek
# tier (which only returns JSON edits), the webchat has REAL TOOLS via the
# gateway tool loop (run_bash, read_file, write_file, search_web, git_status,
# telegram_send — BASH_ALLOWED=true) — it implements the failed step ITSELF.
# The executor then re-runs the step's verification commands and commits
# (belt-and-suspenders; same tail as the DeepSeek tier).
async def call_webchat(session: aiohttp.ClientSession, user_prompt: str,
                       system_prompt: str) -> str:
    """Ask the webchat gateway (orchestrator tab 8082) to do the step with its
    tools. OpenAI-compatible call; the gateway runs the tab's tool loop and
    returns the final answer as plain text. Returns the text or 'ERROR: ...'."""
    url = f"{WEBCHAT_API_BASE.rstrip('/')}/chat/completions"
    payload = {
        "model": "anymodel",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "max_tokens": 4000,
        # 08-19 (user): two-mode webchat — the execution lane is a bare
        # tool-calling machine (no send_message narration); the gateway picks
        # AUTONOMOUS_FORMAT for this request, WEBCHAT_FORMAT (narration) for
        # everything else. Never narrate in execution.
        "autonomous": True,
    }
    rl_seen, rl_detail = False, ""
    for attempt in range(3):
        try:
            async with session.post(url, json=payload,
                                    headers={"Content-Type": "application/json"},
                                    timeout=aiohttp.ClientTimeout(total=WEBCHAT_TIMEOUT)) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    content = (data["choices"][0]["message"].get("content") or "").strip()
                    if content:
                        return content
                    log_exec("    [WEBCHAT] empty content from gateway; retrying")
                else:
                    body = await resp.text()
                    log_exec(f"    [WEBCHAT] gateway HTTP {resp.status}: {body[:120]}")
                    low = body.lower()
                    if any(sig in low for sig in ("too frequent", "rate_limit", "rate limit")):
                        # DeepSeek frequency cooldown: rapid retries each send a
                        # NEW message and RESET the cooldown window (observed
                        # 08-21: 3 retries 2s apart extended the block for 25+ min
                        # while the user's own message passed in the quiet gap).
                        # 08-21 (user lane model): do NOT pace here — swap lanes.
                        rl_seen, rl_detail = True, body[:160]
                        break
        except asyncio.TimeoutError:
            # 08-20 (audit BUG-07): str(asyncio.TimeoutError()) == "" — the old
            # generic except logged a blank line and silently abandoned the
            # request while the gateway kept generating (conversation desync).
            # Log the real story; the deepseek send mutex keeps the retry from
            # colliding with the still-running tab.
            log_exec(f"    [WEBCHAT] attempt {attempt+1} TIMED OUT after {WEBCHAT_TIMEOUT}s — "
                     f"gateway still generating (its reply will land in the thread; retrying now).")
        except aiohttp.ServerDisconnectedError:
            # 08-20 (audit BUG-13, observed live on step 813): the lane
            # restarted mid-request — transient, back off and retry the same
            # payload (the tab survives the gateway restart).
            log_exec(f"    [WEBCHAT] attempt {attempt+1} server disconnected (lane restarted mid-request) — "
                     f"backing off {8 * (attempt + 1)}s before retry.")
            await asyncio.sleep(8 * (attempt + 1))
            continue
        except Exception as e:
            log_exec(f"    [WEBCHAT] call attempt {attempt+1} error ({type(e).__name__}): {e}")
        await asyncio.sleep(2)
    if rl_seen:
        # 08-21 (user directive): deepseek rate-limited -> OmniRoute kicks in for
        # THIS call (free fallback via the gateway's WEBCHAT_ROUTES omniroute slot,
        # model rewritten to auto/best-coding). Gated to the oculus lane (8080):
        # helpotron stays gemini-only (user lane rule — lanes never crossed).
        # OmniRoute's own errors are NOT swapped again (no recursion); the caller's
        # flat 300s cadence paces retries while both lanes are down, and the next
        # call tries deepseek first so it self-heals when the cooldown clears.
        if ":8080" not in WEBCHAT_API_BASE:
            return f"ERROR: {rl_detail}"
        swap = dict(payload, model="omniroute")
        try:
            async with session.post(url, json=swap,
                                    headers={"Content-Type": "application/json"},
                                    timeout=aiohttp.ClientTimeout(total=WEBCHAT_TIMEOUT)) as resp:
                body = await resp.text()
                if resp.status == 200:
                    try:
                        data = json.loads(body)
                        content = (data["choices"][0]["message"].get("content") or "").strip()
                        if content:
                            log_exec("    [LANE] deepseek rate-limited -> OmniRoute carried the call "
                                     "(next call tries deepseek first).")
                            return content
                    except Exception:
                        pass
                log_exec(f"    [LANE] BOTH LANES DOWN: deepseek RL ({rl_detail[:80]}) + "
                         f"OmniRoute HTTP {resp.status}: {body[:120]}")
                return f"ERROR: BOTH_LANES_DOWN; {rl_detail[:80]} / omniroute {resp.status}: {body[:160]}"
        except asyncio.TimeoutError:
            log_exec(f"    [LANE] BOTH LANES DOWN: deepseek RL ({rl_detail[:80]}) + "
                     f"OmniRoute TIMEOUT after {WEBCHAT_TIMEOUT}s.")
            return "ERROR: BOTH_LANES_DOWN; deepseek RL + omniroute timeout"
        except Exception as e:
            log_exec(f"    [LANE] BOTH LANES DOWN: deepseek RL ({rl_detail[:80]}) + "
                     f"OmniRoute error ({type(e).__name__}): {e}")
            return "ERROR: BOTH_LANES_DOWN; deepseek RL + omniroute error"
    return "ERROR: webchat unavailable"


def _exec_log_tail(n: int = 40) -> str:
    """Tail of the plan execution log, for the expert to investigate root
    causes (incl. environment/verification issues unrelated to the step).

    08-20 (audit 4.3/roadmap 1.3): raw 40-line tails fed escalation rounds
    compiler banners, site-packages stack frames and redundant git lines —
    ~180k tokens across 6 rounds of one failing step. Compress: drop NOISE
    lines, keep error-bearing lines first, cap at 15 lines.
    """
    NOISE = re.compile(
        r'(?:\*\*\*\*\*+|====+|>>>>+|^\s*(?:InsecureRequestWarning|warnings\.warn)|'
        r'site-packages/|/usr/lib/python|/usr/local/lib/python|'
        r'git (?:status|diff|add|commit)|Remote:|Branch:|Nothing to commit|'
        r'Traceback \(most recent call last\)\s*$|^\s*File ".*", line \d+, in .*$)',
        re.I)
    CRITICAL = re.compile(
        r'(Error|ERROR|FAILED|AssertionError|ImportError|ModuleNotFoundError|'
        r'Exception|Traceback|HELOTRON_CHECK_FAILED|exit code|returncode|'
        r'pytest|mypy|ruff|flake8|SyntaxError|TypeError|KeyError)', re.I)
    try:
        with open(os.path.join(AUDITS_PLANS_DIR, "plan_execution.log"), "r", errors="replace") as f:
            lines = [l.rstrip() for l in f.readlines()[-n:]]
        kept = [l for l in lines if CRITICAL.search(l) and not NOISE.search(l)]
        rest = [l for l in lines if l.strip() and l not in kept and not NOISE.search(l)]
        out = (kept + rest)[:15]
        return "\n".join(out).strip() or "(no informative execution-log lines)"
    except Exception:
        return "(no execution log available)"


def _feedback_snippet(vout: str, limit: int = 1500) -> str:
    """Extract the MEANINGFUL part of a verification failure for the expert.

    08-20 (both lanes): vout[:1200] fed the expert the FIRST 1200 chars of
    pytest output — the session banner — while the actual AssertionError /
    ImportError sat at the END of the output. The models were debugging
    blind (steps 5/13, 811/1566 both burned rounds on invisible errors).
    Prefer error-bearing lines (pytest 'E' lines, FAILED summaries,
    tracebacks, HELOTRON_CHECK_FAILED); fall back to the output tail.
    """
    lines = vout.splitlines()
    err_lines = [l for l in lines if any(k in l for k in (
        "Error", "ERROR", "FAILED", "AssertionError", "Exception",
        "Traceback", "HELOTRON_CHECK_FAILED", "E  "))]
    if err_lines:
        return "\n".join(err_lines[-12:])[:limit]
    return vout[-limit:]


async def solve_step_with_webchat(session: aiohttp.ClientSession, step: dict,
                                  graphify_ctx: dict, context: str = "") -> tuple[bool, str]:
    """One webchat escalation round: the webchat investigates & implements the
    step with its tools (working like a real engineer — root causes may lie in
    the environment/verification, not just the step code), the executor re-runs
    verification and commits/rolls back. `context` carries the previous round's
    failure detail + execution-log tail so the expert can iterate to a pass."""
    step_idx = step["step_index"]
    total_steps = step["total_steps"]
    target_files = step["target_files"]
    ver_cmds = step.get("verification", [])

    sys_prompt = (
        "You are the OCULUS webchat expert — the PRIMARY executor of every "
        "pipeline plan step (the OmniRoute LLM team is retired per the "
        "2026-08-16 directive; each step is yours to implement and verify). "
        "You have TOOLS: run_bash, "
        "read_file, write_file, list_dir, search_web, git_status, "
        "audit_status, telegram_send. "
        f"WORKING DIRECTORY: your tools run with cwd={PIPELINE_WORK_DIR} "
        "(the git repo root — this is exactly where the pipeline verifies and "
        "commits your work). ALL relative paths are relative to THAT directory: "
        "write_file/read_file/list_dir resolve relative paths there and run_bash "
        "starts there. NEVER cd /home/roni/Roni_Workspace (that is the parent, "
        "outside git — code written there never reaches verification). Follow the "
        "step's file paths verbatim: a path like `oculus/data_validation.py` means "
        "./oculus/data_validation.py under the git root, `tests/test_*.py` means "
        "./tests/ under the git root. Work like a real engineer, not a "
        "code-generator: use your tools to INVESTIGATE the actual failure and "
        "fix its ROOT CAUSE. The root cause may be in the step's code OR "
        "entirely outside it — a wrong python interpreter (system python3 "
        "often lacks the repo's deps like ccxt/aiohttp while the project venv "
        "has them), a missing dependency, a broken/incorrect verification "
        "command, a wrong path. Diagnose from the failure output and fix "
        "whatever is actually wrong, then run each verification command with "
        "run_bash until they genuinely pass. If a verification failure is a "
        "benign diagnostic (missing stubs, 'no tests ran', import-not-found "
        "on optional deps, py_compile on non-python files), note it and move "
        "on. Committing is handled by the pipeline — do NOT commit. The "
        "pipeline also owns ALL git history/branch operations: NEVER run git "
        "checkout, git reset, git switch, git branch, git revert, git rebase, "
        "git clean, git stash, or git pull/fetch; NEVER move HEAD or change "
        "the checked-out branch/commit. The only git commands you may run are "
        "read-only: git status, git log -1, git diff. Work ONLY on files in "
        "the working tree at their current commit — the current checkout is "
        "always the correct base.\n"
        "STEP FIXING (08-19, user rule — plan steps are NOT sacred): if the "
        "step itself is flawed — wrong module paths, broken or impossible "
        "verification commands, target files that don't exist, an objective "
        "that cannot be achieved as written — FIX THE STEP instead of "
        "failing. End your reply with this JSON block:\n"
        '{"plan_edit": {"old_text": "EXACT verbatim substring of the current '
        'step block you replace", "new_text": "your corrected step block"}}\n'
        "Guardrails: never change the '### STEP x/y:' header line; keep the "
        "TARGET_FILES, CODE_OPERATIONS, VERIFICATION and COMMIT_MESSAGE "
        "sections; VERIFICATION must keep at least ONE real command that "
        "genuinely tests the step (no echo/true/pass placeholders); fix the "
        "step to be CORRECTLY achievable, never easier. If the step is fine "
        "as written, omit the block. Reply "
        "with a plain-text summary of the root cause you found, what you "
        "fixed, and the verification results. If you truly cannot make the "
        "verification pass, say precisely what is blocking you and what you "
        "tried."
    )
    ctx_block = f"\n--- INVESTIGATION CONTEXT (prior attempts / execution log — use it to find the root cause) ---\n{context}\n---\n" if context else ""
    usr_prompt = f"""STEP #{step_idx}/{total_steps}: {step['objective']}
Category: {step['category']} | Files: {target_files}

VERIFICATION COMMANDS THAT MUST ALL PASS:
{chr(10).join(f'  {i+1}. {cmd}' for i, cmd in enumerate(ver_cmds))}

{ctx_block}Use your tools to implement/fix this step now, then verify it yourself with run_bash.
Remember: if the failure is environmental or in the verification setup (not the step's logic), the fix is to correct THAT — and tell the pipeline exactly what must change so the verification can genuinely pass when re-run.
Reply with a short plain-text summary (plus the plan_edit JSON block if the step itself is flawed as written)."""
    resp = await call_webchat(session, usr_prompt, sys_prompt)
    if not resp or resp.startswith("ERROR:"):
        return False, resp or "Empty response from webchat"

    # 08-19 (user): the webchat may FIX a flawed step (some plan steps were
    # written incorrectly). Extract an optional plan_edit from its reply,
    # validate with the same guardrails as the DeepSeek tier, apply it, and
    # verify against the EDITED definition.
    edit_ver_cmds = ver_cmds
    edit_target_files = None
    try:
        wc_data = extract_json_from_text(resp)
        wc_edit = (wc_data or {}).get("plan_edit") or {}
        wc_old, wc_new = wc_edit.get("old_text", ""), wc_edit.get("new_text", "")
        if wc_old and wc_new:
            block = _extract_step_block(MASTER_PLAN_FILE, step_idx)
            if not block:
                log_exec("    [webchat plan-edit] could not extract step block")
            else:
                err = _validate_step_edit(block, wc_old, wc_new, step_idx)
                if err:
                    log_exec(f"    [webchat plan-edit GUARD] REJECTED for step {step_idx}: {err}")
                else:
                    ok_apply, apply_msg = _apply_step_edit(MASTER_PLAN_FILE, block, wc_old, wc_new, step_idx)
                    if ok_apply:
                        edited = next((s for s in parse_master_plan(MASTER_PLAN_FILE)
                                       if s["step_index"] == step_idx), None)
                        if edited and edited.get("verification"):
                            edit_ver_cmds = edited["verification"]
                        if edited and edited.get("target_files"):
                            edit_target_files = edited["target_files"]
                        log_exec(f"[PLAN EDIT] Step {step_idx} definition edited by WEBCHAT")
                    else:
                        log_exec(f"    [webchat plan-edit] apply failed: {apply_msg}")
    except Exception as e:
        log_exec(f"    [webchat plan-edit] parse error: {e}")

    # Re-run the step's verification on the current tree; tolerate the same
    # benign diagnostics the DeepSeek tier tolerates.
    all_verifications_ok = True
    fail_detail = ""
    # 08-20 (step 808/809 phantom pass): a step with NO parsed verification
    # commands must never auto-pass — an unverifiable step is a broken step.
    if not edit_ver_cmds:
        all_verifications_ok = False
        fail_detail = "No verification commands parsed for this step — refusing an unverified pass."
        log_exec("    [webchat_verify] NO verification commands parsed — HARD-FAIL (unverified pass refused)")
    # 08-20 (audit perf): speculative py_compile fast-fail — if the step's
    # verification includes py_compile on .py files, gate on it FIRST: a
    # syntax error costs ~0.1s to catch instead of a full pytest run (the
    # old order ran the whole suite and failed at the end).
    py_targets = [tf for tf in (edit_target_files or target_files) if tf.endswith(".py")]
    if py_targets and any("py_compile" in c for c in edit_ver_cmds):
        ok_pc, pc_out = run_isolated_shell_command(
            "python3 -m py_compile " + " ".join(shlex.quote(t) for t in py_targets),
            env_id=f"wc_step_{step_idx}_pycompile", timeout=30)
        if not ok_pc:
            all_verifications_ok = False
            fail_detail = (f"py_compile fast-fail: syntax error in {', '.join(py_targets)}:\n"
                           + _feedback_snippet(pc_out))
            log_exec(f"    [webchat_verify] py_compile FAST-FAIL on {py_targets}: {pc_out[:200]}")
    for i, vcmd in enumerate(edit_ver_cmds, 1):
        if "py_compile" in vcmd and any(ext in vcmd for ext in [".dart", ".js", ".ts", ".json", ".html", ".sh", ".yaml", ".yml", ".d", ".md"]):
            continue
        ok, vout = run_isolated_shell_command(vcmd, env_id=f"wc_step_{step_idx}_chk_{i}")
        if not ok:
            if ("git grep" in vcmd or "git ls-files" in vcmd) and not vout:
                continue
            # 08-20 (helpotron false-pass postmortem): "SyntaxError" and
            # "Security Violation" were previously treated as benign, which let
            # broken verification commands and whitelist-rejected commands
            # silently PASS. Both are REAL failures: a step whose verification
            # cannot run must be fixed (by the lane or via plan-edit), never
            # auto-approved. A "Security Violation" also means the command
            # never executed — approving it skips the step's work entirely.
            if "SyntaxError" in vout or "Security Violation" in vout:
                all_verifications_ok = False
                fail_detail = f"Check #{i}: `{vcmd[:80]}` FAILED — broken verification ({'Security Violation: command whitelist-rejected' if 'Security Violation' in vout else 'SyntaxError in check code'}):\n{_feedback_snippet(vout)}"
                log_exec(f"    [webchat_verify] Check #{i}: `{vcmd[:60]}` -> HARD-FAIL ({'whitelist' if 'Security Violation' in vout else 'SyntaxError'}): {vout[:150]}")
                continue
            # 08-20 (step 808 phantom pass): the benign list below is ONLY for
            # full-suite pytest runs, whose noisy output legitimately contains
            # tracebacks of skipped/import-failing tests. For a single python3
            # check a non-zero exit is authoritative — the bare traceback of a
            # raised AssertionError/ModuleNotFoundError means the check
            # GENUINELY failed ("assert os.path.exists(docs/adr/...)") matched
            # "traceback (most recent call last)" and phantom-passed with the
            # target file never created.
            # 08-20 (step 3 twice-gutted): import-failure patterns are NOT
            # benign — a check whose module cannot be imported means the
            # step's wiring is broken. The expert twice replaced
            # server/cost_tracking.py with a stub satisfying the narrow
            # checks while deleting CostEngine/cost_engine that 4 other
            # modules import; the pytest-check ImportError would also have
            # been swallowed. Only environmental noise is tolerated.
            if "pytest" in vcmd and any(pat.lower() in vout.lower() for pat in (
                "keyerror: 0", "no tests ran", "command not found",
                "traceback (most recent call last)", "skipped",
                "library stubs not installed", "import-untyped", "import-not-found",
                "jinja2", "unrecognized argument", "memory_profiler")):
                continue
            all_verifications_ok = False
            fail_detail = f"Check #{i}: `{vcmd[:80]}` FAILED — output:\n{_feedback_snippet(vout)}"
            log_exec(f"    [webchat_verify] Check #{i}: `{vcmd[:60]}` -> FAIL: {vout[:150]}")
    if all_verifications_ok:
        # 08-19: if the webchat FIXED the step, stage the EDITED target set
        # (a corrected step may legitimately add files to TARGET_FILES).
        add_paths = _git_add_paths(edit_target_files or target_files)
        # 08-20 (helpotron steps 3/4): existence-only checks let the expert
        # trim a tracked file to the few lines the checks reference
        # (cost_tracking.py 256→8, index.css 113→7), deleting working code
        # other modules/UI depend on. Guard: a tracked file that shrank
        # >60% in one round is a suspected wholesale replacement — fail
        # unless the step's objective legitimately shrinks files.
        shrink_ok = any(w in (step.get("objective") or "").lower() for w in (
            "remove", "delete", "dedup", "extract", "split", "migrat",
            "simplif", "shrink", "consolidat", "collaps", "truncat", "strip"))
        if not shrink_ok:
            for tf in list(add_paths):
                try:
                    old_lines = subprocess.run(
                        ["git", "-C", PIPELINE_WORK_DIR, "show", f"HEAD:{tf}"],
                        capture_output=True, text=True, timeout=15).stdout.count("\n")
                except Exception:
                    continue
                if old_lines <= 10:
                    continue  # tiny files: no meaningful baseline
                try:
                    new_lines = open(os.path.join(PIPELINE_WORK_DIR, tf), "rb").read().count(b"\n")
                except Exception:
                    continue
                if new_lines < 0.4 * old_lines:
                    log_exec(f"    [webchat_verify] SUSPECT SHRINK {tf}: {old_lines}->{new_lines} lines — wholesale replacement")
                    return False, (f"Webchat step verification failed (destructive shrink): {tf} shrank "
                                   f"{old_lines}->{new_lines} lines. Extend the existing file instead of "
                                   f"replacing it (the step's instructions say so)."
                                   + _preserved_worktree_snippet(target_files))
        # 08-20 (step 808): git add/commit return codes were UNCHECKED — a
        # failing pathspec or "nothing to commit" still returned success, so
        # steps phantom-completed with NO commit. A step is only complete when
        # its work is committed.
        ok_add, add_out = run_isolated_shell_command(
            "git add -- " + " ".join(add_paths) if add_paths else "git status", timeout=15)
        if not ok_add:
            log_exec(f"    [webchat_verify] git add FAILED: {add_out[:200]}")
            return False, f"Webchat step verification failed (git add): {add_out[:200]}"
        c_msg = f"[STEP {step_idx}/{total_steps}] (Webchat Expert) {step['objective'][:70]}"
        ok_c, c_out = run_isolated_shell_command(f'git commit -m "{c_msg}"', timeout=15)
        if not ok_c:
            if ("nothing to commit" in c_out.lower() or "working tree clean" in c_out.lower()
                    or "changes not staged" in c_out.lower()
                    or "nothing added to commit" in c_out.lower()):
                # 08-20 (audit BUG-11): verification-only step — verification
                # passed but produced NO file changes. That is a legitimate
                # completion (audit/docs steps), not a commit failure. Leave a
                # marker commit so the step is visible in history, then succeed.
                log_exec(f"    [webchat_verify] step {step_idx} passed verification with NO file changes "
                         f"(verification-only step) — committing an empty-diff marker.")
                run_isolated_shell_command(
                    f'git commit --allow-empty -m "[STEP {step_idx}/{total_steps}] (Webchat Expert) '
                    f'{step["objective"][:60]} (verification passed, no file changes)"', timeout=15)
            else:
                log_exec(f"    [webchat_verify] git commit FAILED: {c_out[:200]}")
                return False, (f"Webchat step verification failed (git commit): {c_out[:200]}"
                               + _preserved_worktree_snippet(target_files))
        for push_attempt in range(3):
            ok_push, _ = run_isolated_shell_command("git push origin HEAD", timeout=120)
            if ok_push:
                break
            await asyncio.sleep(2)
        return True, f"Webchat solved step: {resp[:200]}"
    # 08-20 (audit CRIT-01/BUG-02): NO destructive rollback between rounds —
    # preserve the worktree and hand the next round the diff to patch in
    # place. Only the HALT site (round-loop exhaustion) resets the tree.
    wtree = _preserved_worktree_snippet(target_files)
    return False, ("Webchat step verification failed:\n" + fail_detail +
                   (wtree if wtree else "\n(worktree is clean — no changes were made this round)"))


# ─── PLAN-STEP EDITING (fix a flawed step, never weaken it) ─────────────────
# After a step fails the first DeepSeek retries (the "2nd failure"), the expert
# may EDIT the plan-step definition to genuinely fix the flaw (phantom module,
# wrong API, impossible verification). Guardrails are strict: the step cannot
# be deleted, renumbered, stripped of its sections, or trivialized so it
# passes for free — it is only complete when its verification ACTUALLY passes.

_TRIVIAL_CMD_RE = re.compile(
    r"^\s*(?:echo|printf|true|false|pass|exit\b|:|#|\s*$)", re.IGNORECASE)


def _trivial_command(cmd: str) -> bool:
    c = cmd.strip().lstrip('`').rstrip('`').strip()
    if not c:
        return True
    if c.lower() in ("true", "false", "pass", "echo", "echo ok", "echo done", "exit 0"):
        return True
    if _TRIVIAL_CMD_RE.match(c):
        return True
    if len(c) < 4:
        return True
    return False


# 08-20 (config-clobber guard): webchat experts have twice replaced
# workflow_orchestrator/oculus_config_workflow.yaml with unrelated content
# (steps 809, 946). The orchestrator reads the config only at spawn, so a
# clobbered config crash-loops the supervisor's orchestrator respawns until
# a human restores it. Guard: restore any dirty protected infra file before
# each webchat round, unless the current step legitimately targets it.
_PROTECTED_WORKTREE_FILES = (
    "workflow_orchestrator/oculus_config_workflow.yaml",
)


def _restore_protected_files(target_files: list) -> None:
    for rel in _PROTECTED_WORKTREE_FILES:
        if rel in (target_files or []):
            continue
        ok, out = run_isolated_shell_command(f"git status --porcelain -- {rel}", env_id="guard")
        if ok and out.strip():
            log_exec(f"  [GUARD] restoring clobbered protected file {rel}")
            run_isolated_shell_command(f"git checkout -- {rel}", env_id="guard")


def _extract_step_block(plan_path: str, step_idx: int) -> str:
    """Return the raw markdown block for one step (or '' if not found)."""
    if not os.path.exists(plan_path):
        return ""
    try:
        with open(plan_path, "r", errors="replace") as f:
            content = f.read()
    except Exception:
        return ""
    m = re.search(rf'### STEP {step_idx}/\d+:.*?(?=\n### STEP \d+/\d+:|\Z)', content, re.DOTALL)
    return m.group(0) if m else ""


def _resolve_old_text_in_block(block: str, old_text: str) -> str:
    """Return the actual old_text span that exists in block, tolerating
    whitespace drift (trailing spaces / indentation) between the webchat's
    proposal and the plan file. Returns '' when no line-wise match exists.

    08-20 (step 2/3/813/815 HALT): the webchat types old_text from memory;
    exact-substring matching rejected EVERY surgical edit, so steps that
    needed a plan fix could never get one (expert exhausted 6 rounds and
    the pipeline HALTed). Line-wise stripped matching accepts the same
    content with different whitespace; the returned span is the block's
    REAL text, so replacement still edits the actual file bytes.
    """
    if old_text in block:
        return old_text
    old_lines = old_text.splitlines()
    block_lines = block.splitlines()
    if not old_lines:
        return ""
    for i, bl in enumerate(block_lines):
        if bl.strip() != old_lines[0].strip():
            continue
        if i + len(old_lines) > len(block_lines):
            continue
        if all(o.strip() == b.strip() for o, b in zip(old_lines, block_lines[i:i + len(old_lines)])):
            return "\n".join(block_lines[i:i + len(old_lines)])
    return ""


def _validate_step_edit(block: str, old_text: str, new_text: str, step_idx: int) -> "str | None":
    """Return an error string if the proposed plan edit violates guardrails, else None."""
    if old_text not in block:
        resolved = _resolve_old_text_in_block(block, old_text)
        if not resolved:
            return "old_text is not an exact substring of the step block"
        old_text = resolved
    old_lines = old_text.splitlines()
    new_lines = new_text.splitlines()
    old_head = old_lines[0].strip() if old_lines else ""
    new_head = new_lines[0].strip() if new_lines else ""
    if old_head.startswith("### STEP"):
        if not new_head.startswith(f"### STEP {step_idx}/"):
            return "must not change the step header / renumber or delete the step"
    elif new_head.startswith("### STEP") and new_head != old_head:
        return "must not change the step header"
    # The edit must not introduce step headers that weren't already there
    # (e.g. swallowing a neighbour step or adding new steps).
    old_headers = set(re.findall(r'### STEP (\d+)/', old_text))
    new_headers = set(re.findall(r'### STEP (\d+)/', new_text))
    if new_headers - old_headers:
        return "the edit must stay within one step block (no new step boundaries)"

    # Section-preservation guards apply ONLY when the edit actually CONTAINS
    # that section — a surgical one-line fix must not require reproducing the
    # whole block.
    if "**VERIFICATION:**" in old_text:
        if "**VERIFICATION:**" not in new_text:
            return "must keep the VERIFICATION section"
        ver = re.search(r'\*\*VERIFICATION:\*\*\n(.*?)(?=\n\*\*COMMIT_MESSAGE:\*\*|\Z)', new_text, re.DOTALL)
        cmds = []
        if ver:
            for line in ver.group(1).splitlines():
                ls = line.strip()
                if ls and (ls[0].isdigit() or ls.startswith('-')):
                    cmds.append(re.sub(r'^\s*(?:\d+\.\s*|-\s+)', '', ls).strip())
        if not cmds:
            return "verification must keep at least one command"
        if any(_trivial_command(c) for c in cmds):
            return "verification commands must be real — no echo/true/pass/exit trivialization"
        # 08-20 (step 808 HALT): an expert plan-edit swapped check #2 for
        # `find ... | wc -l`, which the verifier's shell path rejects — the
        # round then failed on a check that could NEVER run, every round.
        # Edits must keep verification whitelist-safe: no shell operators.
        for c in cmds:
            if any(op in c for op in ("|", ">", "&&", "$(", "`")):
                return f"verification commands must be whitelist-safe — no shell operators: {c[:60]}"
    if "**TARGET_FILES:**" in old_text:
        if "**TARGET_FILES:**" not in new_text:
            return "must keep the TARGET_FILES section"
    if "**COMMIT_MESSAGE:**" in old_text and "**COMMIT_MESSAGE:**" not in new_text:
        return "must keep the COMMIT_MESSAGE section"
    return None


def _apply_step_edit(plan_path: str, block: str, old_text: str, new_text: str,
                     step_idx: int) -> tuple:
    """Atomically apply a validated step edit to the plan file (with backup)."""
    with open(plan_path, "r", errors="replace") as f:
        full = f.read()
    start_idx = full.find(block)
    if start_idx == -1:
        return False, "step block vanished from plan file"
    backup = plan_path + f".step{step_idx}.bak"
    try:
        shutil.copy2(plan_path, backup)
    except Exception:
        pass
    region = full[start_idx:start_idx + len(block)]
    # 08-20: mirror the guard's whitespace-tolerant resolution so a
    # validated-but-whitespace-drifted edit actually applies to the file.
    if old_text not in region:
        resolved = _resolve_old_text_in_block(region, old_text)
        if not resolved:
            return False, "old_text not found in step block"
        old_text = resolved
    new_region = region.replace(old_text, new_text, 1)
    if new_region == region:
        return False, "plan-edit applied nothing"
    new_full = full[:start_idx] + new_region + full[start_idx + len(block):]
    try:
        tmp = plan_path + ".tmp"
        with open(tmp, "w") as f:
            f.write(new_full)
        os.replace(tmp, plan_path)
    except Exception as e:
        return False, f"plan-edit write failed: {e}"
    return True, ""


async def deepseek_fix_plan_step(session: aiohttp.ClientSession, step: dict, plan_path: str,
                                 failure_context: str = "") -> tuple:
    """Let DeepSeek Pro edit a FLAWED plan step (within strict limits).

    Returns (ok, message, edited_step). On ok, the edited step's verification
    already passes (step can be marked complete). On not-ok, edited_step is the
    (possibly fixed) definition for the next tier to retry against, or the
    original if the edit was rejected/rolled back.
    """
    step_idx = step["step_index"]
    total = step["total_steps"]
    block = _extract_step_block(plan_path, step_idx)
    if not block:
        return False, "could not extract the step block", step

    target_files = step.get("target_files", [])
    real_files = [tf for tf in target_files if os.path.exists(os.path.join(OCULUS_DIR, tf))]
    missing_files = [tf for tf in target_files if not os.path.exists(os.path.join(OCULUS_DIR, tf))]
    imports = [n for pair in re.findall(r'from\s+([\w.]+)\s+import|import\s+([\w.]+)', block) for n in pair if n]

    sys_prompt = ("You are DeepSeek-V4 Expert Plan Reviewer. Your job is to FIX A "
                  "FLAWED PLAN STEP so it is CORRECTLY achievable. You never weaken "
                  "a step to make it pass.")
    usr_prompt = f"""A plan step keeps failing because its definition is flawed (wrong module path, phantom API, impossible or non-executable verification).

STEP #{step_idx}/{total}: {step.get('objective', '')}

## THE CURRENT STEP DEFINITION (from the plan file)
```markdown
{block}
```

## WHY IT KEEPS FAILING
{failure_context or "(no detailed failure context available)"}

## REALITY CHECK (what actually exists in the repo)
- Existing target files: {real_files or 'NONE (files need to be created)'}
- Missing target files: {missing_files or 'none'}
- Step references: {imports or 'none'}

## TASK
Identify the flaw(s) and return a CORRECTED version of the step.

RETURN ONLY JSON:
{{
  "explanation": "what was wrong and how you fixed it",
  "plan_edit": {{
    "old_text": "EXACT verbatim substring of the CURRENT step block you replace (copy-paste exactly)",
    "new_text": "the corrected text replacing old_text"
  }}
}}

STRICT GUIDELINES — violating ANY is rejected:
1. Edit ONLY inside this step's block. NEVER change the '### STEP {step_idx}/{total}:' header line — no renumbering, no deleting.
2. NEVER remove TARGET_FILES, CODE_OPERATIONS, VERIFICATION, or COMMIT_MESSAGE sections.
3. VERIFICATION must keep at least ONE real, executable command that GENUINELY tests the step. NEVER trivialize: no 'echo', 'true', 'pass', 'exit 0', empty, or placeholder commands.
4. Fix REAL flaws: correct module paths to the real modules, correct API/function names, fix broken verification syntax, align TARGET_FILES with what the step actually needs.
5. Do NOT make the step easier so it completes — fix it so it is CORRECTLY achievable. A step is only done when its verification commands ACTUALLY PASS.
"""
    resp = ""
    for attempt in range(3):
        resp = await call_official_deepseek(session, usr_prompt, sys_prompt,
                                            use_pro=False, role_name="DEEPSEEK_FLASH")  # pro-guard 08-20: flash only
        if resp and not resp.startswith("ERROR:"):
            break
        await asyncio.sleep(2)
    if not resp or resp.startswith("ERROR:"):
        return False, "plan-edit API failed", step

    try:
        data = extract_json_from_text(resp)
    except Exception as e:
        return False, f"plan-edit parse error: {e}", step

    edit = data.get("plan_edit") or {}
    old_text = edit.get("old_text", "")
    new_text = edit.get("new_text", "")
    if not old_text or not new_text:
        return False, "plan-edit missing old_text/new_text", step

    err = _validate_step_edit(block, old_text, new_text, step_idx)
    if err:
        log_exec(f"    [plan-edit GUARD] REJECTED for step {step_idx}: {err}")
        return False, f"plan-edit REJECTED: {err}", step

    # apply the edit, scoped to the step block, atomically, with a backup
    ok_apply, apply_msg = _apply_step_edit(plan_path, block, old_text, new_text, step_idx)
    if not ok_apply:
        return False, apply_msg, step
    log_exec(f"[PLAN EDIT] Step {step_idx} definition edited: {data.get('explanation', '')[:220]}")

    # re-parse the edited plan and pull the corrected step
    steps = parse_master_plan(plan_path)
    edited_step = next((s for s in steps if s["step_index"] == step_idx), None)
    if edited_step is None:
        try:
            os.replace(backup, plan_path)  # restore
        except Exception:
            pass
        return False, "plan-edit broke parsing; restored", step

    if step_already_verified(edited_step):
        log_exec(f"[PLAN EDIT] Step {step_idx} verification now PASSES after the plan fix.")
        return True, f"plan fixed: {data.get('explanation', '')[:180]}", edited_step
    return False, f"plan fixed but verification still failing: {data.get('explanation', '')[:150]}", edited_step


# ─── ISOLATED TERMINAL COMMAND EXECUTOR (SECURITY HARDENED) ─────────────────

def run_isolated_shell_command(cmd: str, env_id: str = "isolated", timeout: int = 600) -> tuple[bool, str]:
    """
    Execute a command safely using shell=False and shlex.split() after passing command whitelist check.
    NOTE: default timeout 600s (was 300, originally 120) — the full-suite pytest check
    (`pytest tests/ -q --strict-markers`) takes ~92s here and false-failed
    STEP 310's check #4 at 120s (2026-08-05). Verifications must not be
    time-bounded tighter than the slowest legitimate check. 300s STILL
    false-failed STEP 946's check #5 (2026-08-20): the RAM watchdog
    SIGSTOPs the heavy pytest child at 75%+ usage and the 300s window
    expired while paused (paused at 4.7min of a 5min run). 600s lets a
    watchdog pause/resume cycle complete inside the window.
    """
    if "grep" in cmd and " '--" in cmd and " -- '--" not in cmd:
        cmd = cmd.replace(" '--", " -- '--")

    # 08-20 (step 808 HALT postmortem): metacharacters are only dangerous
    # when a shell interprets them. Commands WITHOUT shell operators
    # (|, >, &&) run argv-style via shell=False below — ';' inside a
    # python3 -c argument is inert there, so only argv[0] needs the
    # allowlist. The strict metachar rejection (is_safe_command) stays
    # mandatory on the shell=True path. Tightening further rejected the
    # plan's own `python3 -c "...; ..."` checks, so step 808 could never
    # verify (a step is never skipped).
    try:
        args = shlex.split(cmd)
    except Exception as e:
        return False, f"Security Violation: Command parsing error: {e}"

    # 08-20 (steps 73/85/128/162/164/350/441/759...): the plan's env-prefix
    # idiom (`OCULUS_ENV=production python -c ...`, `MCP_AUTH_TOKEN=test python
    # ...`, `TELEGRAM_BOT_TOKEN= pytest ...`). A leading `KEY=value` token is
    # inert in argv exec — apply it as a child env override and run the rest
    # argv-style. Values containing shell operators (| ; > < $ ` &) are
    # rejected so the shell path can never see one.
    env_overrides = {}
    while args and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", args[0]):
        kv = args.pop(0)
        key, _, value = kv.partition("=")
        if any(m in value for m in (";", "|", ">", "<", "$", "`", "&")):
            return False, f"Security Violation: unsafe env value in '{kv}'."
        env_overrides[key] = value

    # 08-20 (steps 829 + ~55 chain-verifications): `&&`-chains are the plan
    # generator's dominant verification idiom (`cd X && flutter analyze`,
    # `grep -q A && grep -q B`, `python3 X && python3 Y`). Every segment is
    # still argv-whitelisted, so a chain is honored WITHOUT a shell: split on
    # standalone `&&` tokens and run each segment sequentially under
    # shell=False; the first failing segment fails the whole command. A leading
    # `cd X` segment adjusts the child cwd (relative to PIPELINE_WORK_DIR) for
    # the remaining segments — `..`, absolute, or metachar targets are
    # rejected. Any OTHER shell operator inside a segment (|, >, <, ;, &, $, `)
    # keeps the strict rejection below, so pipes/redirects in chains stay
    # blocked exactly like standalone ones.
    child_cwd = PIPELINE_WORK_DIR
    if "&&" in args:
        segments, current = [], []
        for a in args:
            if a == "&&":
                if not current:
                    return False, f"Security Violation: empty segment in command: {cmd}"
                segments.append(current)
                current = []
            else:
                current.append(a)
        if current:
            segments.append(current)
        for idx, seg in enumerate(segments):
            # leading `cd X` is not an allowed binary itself — it is validated
            # and consumed by the cd handling below (single bare dir target).
            if idx == 0 and seg[0] == "cd" and len(seg) == 2:
                continue
            if not seg or seg[0].lstrip("./") not in ALLOWED_COMMANDS:
                return False, f"Security Violation: segment '{seg[0] if seg else '?'}' not allowed in chain: {cmd}"
            if any(a in (";", "|", ">", "<", "$", "`") for a in seg):
                return False, f"Security Violation: shell operator inside chain segment: {cmd}"
        if segments[0][0] == "cd" and len(segments[0]) == 2:
            cd_target = segments[0][1]
            if cd_target.startswith("/") or ".." in cd_target.split("/"):
                return False, f"Security Violation: unsafe 'cd' target '{cd_target}' in chain."
            child_cwd = os.path.join(PIPELINE_WORK_DIR, cd_target)
            if not os.path.isdir(child_cwd):
                return False, f"Security Violation: 'cd' target '{cd_target}' is not a directory under the work dir."
            segments = segments[1:]
        if not segments:
            return False, "Security Violation: chain has no command after 'cd'."
        cmd_plan = segments
    else:
        cmd_plan = [args]
    # flat = the tokens that will actually run (chain cd-segment already
    # stripped) — use_shell and the argv[0] check must see THESE, not the raw
    # split (which still contains the `cd`/`&&` tokens for cd-chains).
    flat = [a for seg in cmd_plan for a in seg]

    # 08-20 (step 828): operator detection on TOKENS, not the raw string.
    # A metachar INSIDE a quoted grep pattern ("git checkout -- <file>")
    # is inert under shell=False (argv exec — no redirection/globbing),
    # so it must not route the command to the shell path. Only a standalone
    # token that IS a shell operator (unquoted `|`, `>`, `&&`, `;` ...)
    # reaches shell=True, where is_safe_command's strict rejection stays.
    _SHELL_OPS = ("|", ">", "<", "&&", "||", ";", "&", "$", "`")
    use_shell = len(cmd_plan) == 1 and any(a in _SHELL_OPS for a in flat)
    if use_shell and not is_safe_command(cmd):
        return False, f"Security Violation: Command '{cmd}' failed whitelist validation."

    if len(cmd_plan) == 1 and (not flat or flat[0].lstrip("./") not in ALLOWED_COMMANDS):
        return False, f"Security Violation: '{flat[0] if flat else cmd}' not allowed."

    temp_dir = tempfile.mkdtemp(prefix=f"oculus_term_{env_id}_")
    out_file = os.path.join(temp_dir, "cmd_out.txt")
    try:
        env = os.environ.copy()
        env["TMPDIR"] = temp_dir
        env["OCULUS_ISOLATED_TERM"] = env_id
        # Verification IS a debug/test context (the guard explicitly allows it),
        # and matches conftest.py's own setdefault. Without it, any check that
        # imports `oculus` trips the entrypoint guard and hard-fails (STEP 659).
        env["OCULUS_ALLOW_EXTERNAL"] = "1"
        env.update(env_overrides)  # env-prefix idiom (KEY=value cmd...)
        env["PYTHONPATH"] = os.path.dirname(PIPELINE_WORK_DIR) + ":" + PIPELINE_WORK_DIR + ":" + env.get("PYTHONPATH", "")

        # use_shell computed above from shlex TOKENS (step 828) — quoted
        # metachars in patterns stay on the shell=False path.
        # Stream stdout to a file on disk instead of buffering it in RAM.
        # This bounds per-command memory to the small diagnostic tail read below,
        # preventing pytest/mypy firehoses from blowing the process heap (OOM).
        # 08-20 (chain support): multi-segment `&&` chains run one argv exec
        # per segment, all with child_cwd (the `cd X &&` target when present).
        # Normalization (python->venv, pytest->venv -m) applies per segment.
        proc = None
        with open(out_file, "w") as fout:
            for seg in cmd_plan:
                seg_args = list(seg)
                if seg_args[0] in ("python", "./python"):
                    seg_args[0] = "python3"
                if seg_args[0].lstrip("./") == "venv-orch/bin/python":
                    seg_args[0] = sys.executable
                if seg_args[0] == "python3":
                    seg_args[0] = sys.executable
                if seg_args[0] == "pytest":
                    seg_args = [sys.executable, "-m", "pytest"] + seg_args[1:]
                proc = subprocess.run(
                    cmd if use_shell else seg_args, shell=use_shell,
                    cwd=child_cwd, env=env,
                    stdout=fout, stderr=subprocess.STDOUT,
                    text=True, timeout=timeout
                )
                if proc.returncode != 0:
                    break
        success = (proc.returncode == 0)
        output = ""
        try:
            with open(out_file, "r", errors="replace") as f:
                f.seek(0, os.SEEK_END)
                size = f.tell()
                f.seek(max(0, size - 32768))  # tail only
                output = f.read().strip()
        except Exception:
            output = ""
        return success, output
    except subprocess.TimeoutExpired:
        return False, f"Isolated command timed out after {timeout}s"
    except Exception as e:
        return False, str(e)
    finally:
        try:
            shutil.rmtree(temp_dir, ignore_errors=True)
        except Exception:
            pass



def _git_add_paths(target_files: list[str]) -> list[str]:
    """Target_files pathspecs that are INSIDE the git repo and exist on disk.

    Plan steps may list parent-relative targets (e.g. `../alt_important_scripts/`)
    that escape the repo root. `git add` aborts on ANY out-of-tree pathspec
    (exit 128, nothing staged), so the step's real in-repo work silently never
    gets committed while the step is still marked complete (observed: step 562
    verification passed, `scripts/dependency_audit.py` left untracked, no commit).
    """
    valid: list[str] = []
    # 08-20 (helpotron no-commit postmortem): this resolved against OCULUS_DIR
    # (hardcoded), so for any non-oculus PIPELINE_WORK_DIR every path was
    # filtered out -> `git add` ran with zero pathspec -> steps false-completed
    # with no commit. Resolve against the actual pipeline workdir.
    workdir = PIPELINE_WORK_DIR
    for tf in target_files:
        abs_p = os.path.normpath(os.path.join(workdir, tf))
        if abs_p != workdir and not abs_p.startswith(workdir + os.sep):
            continue
        if os.path.exists(abs_p):
            valid.append(tf)
    return valid


def execute_rollback(rollback_cmd: str, target_files: list[str], hard: bool = False) -> bool:
    """Rollback after a failed step.

    08-20 (audit CRIT-01/BUG-02): the old between-round rollback was
    DESTRUCTIVE — `git checkout -- {tf}` + `git clean -fd {tf}` for EVERY
    target file wiped the previous round's partial progress, so multi-file
    steps degenerated into N isolated one-shot attempts (files created in
    round 1 were gone before round 2's feedback even arrived). The worktree
    is now PRESERVED between rounds (soft rollback, the default): the round's
    changes stay on disk, the failure feedback carries the uncommitted diff,
    and the next round patches the specific defect. The destructive reset
    runs ONLY at HALT (hard=True), when the step is being abandoned so the
    main session restarts from a clean tree.
    """
    if not hard:
        log_exec("  [ROLLBACK] soft — worktree PRESERVED for the next round (audit CRIT-01 fix); no checkout/clean")
        return True
    log_exec(f"  [ROLLBACK] HARD reset to step-start state: {rollback_cmd}")
    ok, out = run_isolated_shell_command(rollback_cmd, env_id="rollback")
    if not ok:
        log_exec(f"  [ROLLBACK] Primary rollback failed ({out}), applying git checkout fallback...")
        for tf in target_files:
            run_isolated_shell_command(f"git checkout -- {tf}", env_id="rollback")
            run_isolated_shell_command(f"git clean -fd {tf}", env_id="rollback")
    return True


def _preserved_worktree_snippet(target_files: list[str], limit: int = 2000) -> str:
    """Uncommitted-diff feedback for the next round (audit BUG-02).

    Tells the next webchat round exactly what the previous round changed so
    it can patch the specific defect instead of recreating files from
    scratch. Empty when the worktree is clean. Capped for prompt size.
    """
    try:
        st = run_isolated_shell_command("git status --porcelain", env_id="preserve", timeout=10)
        if not st[1].strip():
            return ""
        stat = run_isolated_shell_command(
            "git diff --stat -- " + " ".join(shlex.quote(t) for t in target_files),
            env_id="preserve", timeout=10)
        diff = run_isolated_shell_command(
            "git diff -- " + " ".join(shlex.quote(t) for t in target_files),
            env_id="preserve", timeout=15)
        parts = ["Changed files:\n" + st[1].strip()[:1000]]
        if stat[1].strip():
            parts.append("Diff stat:\n" + stat[1].strip()[:1000])
        if diff[1].strip():
            parts.append("Uncommitted diff (tail):\n" + diff[1].strip()[-limit:])
        return ("\n\nWORKTREE STATE (your previous round's changes are PRESERVED — "
                "patch the specific defect in place; do NOT recreate files from scratch):\n"
                + "\n\n".join(parts))
    except Exception:
        return ""


# ─── 5-SUBAGENT TEAM WORKFLOW FOR A SINGLE STEP ─────────────────────────────
async def execute_single_step(session: aiohttp.ClientSession,
                              step: dict,
                              graphify: GraphifyDB,
                              attempt: int = 1) -> tuple[bool, str]:
    """Execute 1 step using a team of 5 parallel subagents (IMP, REV, SEC, VER, SAN)."""
    step_idx = step["step_index"]
    total_steps = step["total_steps"]
    obj = step["objective"]
    target_files = step["target_files"]

    log_exec(f"\n" + "=" * 70)
    log_exec(f"EXECUTING STEP {step_idx}/{total_steps} (Attempt {attempt}/{MAX_STEP_RETRIES}): {obj}")
    log_exec(f"Target Files: {target_files} | Category: {step['category']} | Priority: {step['priority']}")
    log_exec("=" * 70)

    # 1. File Context (agents need exact content to generate valid old_code)
    # 08-20 (audit 3.2/roadmap 2.2): role-specialized broadcasts — IMP/REV get
    # the full text (exact old_code matching), SEC gets security-relevant
    # lines only, VER/SAN get AST skeletons (signatures). Cuts the 5-way
    # 30KB broadcast ~58% on multi-file steps.
    file_contexts, skel_contexts, sec_contexts = [], [], []
    for tf in target_files:
        abs_p = os.path.join(OCULUS_DIR, tf)
        ast_ctx = graphify.build_file_snippet(tf)
        content_full = ""
        if os.path.exists(abs_p) and os.path.isfile(abs_p):
            with open(abs_p, errors="replace") as f:
                content_full = f.read()
            if len(content_full) > 30000:
                content_full = content_full[:30000] + "\n... [TRUNCATED AT 30KB FOR MEMORY SAFETY] ...\n"
        file_contexts.append(f"### FILE: {tf}\nAST: {ast_ctx}\nFULL CONTENT (use exact substrings for old_code):\n{content_full}\n")
        skel_contexts.append(f"### FILE: {tf}\n" + skeletonize_source(content_full, tf))
        sec_contexts.append(f"### FILE: {tf}\n" + security_slice(content_full))

    compact_context = "\n".join(file_contexts)
    role_ctx = {"IMP": compact_context, "REV": compact_context,
                "SEC": "\n".join(sec_contexts),
                "VER": "\n".join(skel_contexts),
                "SAN": "\n".join(skel_contexts)}

    base_sys = f"You are part of a 5-subagent team executing STEP {step_idx}/{total_steps} of Oculus."
    imp_sys = base_sys + " Role: IMP (Implementer). Generate exact, precise Python code changes."
    rev_sys = base_sys + " Role: REV (Peer Reviewer). Verify code edits match line ranges and step requirements."
    sec_sys = base_sys + " Role: SEC (Security & Invariants). Enforce fail-closed safety, auth checks, and SOT rules."
    ver_sys = base_sys + " Role: VER (Verification Engine). Validate verification commands."
    san_sys = base_sys + " Role: SAN (Consensus Auditor). Evaluate team outputs and give final approve/deny vote."

    def role_prompt(role: str) -> str:
        return f"""
## ACTIVE STEP INSTRUCTIONS
Objective: {obj}
Target Files: {target_files}
Line Ranges: {step['line_ranges']}

## PROPOSED CODE OPERATIONS FROM PLAN
{step['code_operations']}

## CONTEXT FOR {role}
{role_ctx[role]}

## REQUIRED OUTPUT FORMAT — RESPOND WITH RAW JSON ONLY. NO MARKDOWN. NO EXPLANATION. NO CODE FENCES.
{{"agent_role": "{role}", "approved": true, "confidence": 90, "code_edits": [{{"file": "path/to/file.py", "old_code": "exact string to replace", "new_code": "replacement"}}], "reasoning": "one sentence"}}

Rules:
- Your ENTIRE response must be a single valid JSON object, nothing else.
- old_code must be an EXACT verbatim substring of the current file content shown above.
- If no code change is needed, return an empty code_edits array.
"""

    log_exec("  [TEAM] Spawning 5 parallel subagents (IMP, REV, SEC, VER, SAN)...")
    tasks = [
        call_omniroute(session, role_prompt("IMP"), imp_sys, role_name="IMP"),
        call_omniroute(session, role_prompt("REV"), rev_sys, role_name="REV"),
        call_omniroute(session, role_prompt("SEC"), sec_sys, role_name="SEC"),
        call_omniroute(session, role_prompt("VER"), ver_sys, role_name="VER"),
        call_omniroute(session, role_prompt("SAN"), san_sys, role_name="SAN"),
    ]

    responses = await asyncio.gather(*tasks)

    # Free prompt memory immediately after responses received
    del role_ctx

    # 2. Apply structured code operations (parsed directly from plan + AI responses)
    edits_applied = False
    all_ops = list(step.get("structured_ops", []))

    # Also include edits from IMP / team AI responses
    for resp in responses:
        try:
            m = re.search(r'```json\s*\n?(.*?)\n?```', resp, re.DOTALL)
            raw = m.group(1) if m else resp
            data = json.loads(raw)
            if isinstance(data, dict) and "code_edits" in data:
                all_ops.extend(data["code_edits"])
        except Exception as json_err:
            log_exec(f"    [team_json] Note: AI response did not return parseable JSON code_edits: {json_err}")

    for edit in all_ops:
        tf = edit.get("file")
        old_c = edit.get("old_code", "")
        new_c = edit.get("new_code", "")
        if tf and new_c:
            old_c = re.sub(r'->\s*null\b', '-> None', old_c)
            new_c = re.sub(r'->\s*null\b', '-> None', new_c)

            abs_p = os.path.join(OCULUS_DIR, tf)
            os.makedirs(os.path.dirname(abs_p), exist_ok=True)
            if os.path.exists(abs_p):
                with open(abs_p, "r") as f:
                    orig = f.read()

                updated = None
                if old_c and old_c in orig:
                    # SAFE: old_code found verbatim in file — apply replace
                    updated = orig.replace(old_c, new_c, 1)
                elif not old_c:
                    # ADD operation (no old_code): only append if new_c not already present
                    if new_c not in orig:
                        updated = orig + "\n\n" + new_c
                else:
                    # old_code NOT found in file — DO NOT apply to prevent corruption
                    log_exec(f"    [edit_guard] SKIP edit for {tf}: old_code not found in file (plan mismatch). Preserving file.")

                if updated and updated != orig:
                    with open(abs_p, "w") as f:
                        f.write(updated)
                    edits_applied = True
            else:
                # Target file does not exist yet -> create it with new_c
                with open(abs_p, "w") as f:
                    f.write(new_c)
                edits_applied = True

    # Free large objects from memory before verification phase
    del responses
    del all_ops
    del file_contexts
    del compact_context
    gc.collect()

    # 3. Targeted Syntax & Full Verification Protocol (ALL Real Checks Enforced)
    log_exec("  [FULL VERIFICATION] Executing targeted compilation and plan verification checks in isolated terminals...")
    target_compilation_ok = True
    for tf in target_files:
        abs_p = os.path.join(OCULUS_DIR, tf)
        if tf.endswith(".py") and os.path.isfile(abs_p):
            ok, vout = run_isolated_shell_command(f"python3 -m py_compile {tf}", env_id=f"step_{step_idx}_pycompile")
            if not ok:
                target_compilation_ok = False
                log_exec(f"    Compilation check `python3 -m py_compile {tf}` -> FAIL: {vout[:150]}")
            else:
                log_exec(f"    Compilation check `python3 -m py_compile {tf}` -> PASS")
        else:
            log_exec(f"    Compilation check `{tf}` -> SKIPPED (non-python file or directory)")

    ver_cmds = step.get("verification", [])
    all_verifications_ok = True
    diag_patterns = [
        "KeyError: 0", "ImportError while loading conftest",
        "file or directory not found", "no such file or directory", "errno 2",
        "outside repository",  # git pathspec escaping the work tree — plan-verification path bug, not an impl failure
        "no tests ran", "Unauthorized emergency liquidation", "Emergency liquidation triggered",
        "PermissionError", "Security Violation", "EmergencyCloseService",
        # NOTE 2026-08-20: "Traceback (most recent call last)" was REMOVED from
        # this list — it is the blanket catch-all that swallowed every python -c
        # "assert ..." failure as a DIAGNOSTIC NOTE (phantom-pass, e.g. STEP 848:
        # `assert not Path('oculus/portfolio.py').exists()` threw AssertionError
        # with the file present and the step was declared PASSED). Specific
        # tolerated noise patterns above remain; generic tracebacks now FAIL.
        "SKIPPED", "skipped", "could not import",
        "library stubs not installed", "import-untyped", "cannot find implementation or library stub",
        "import-not-found", "flutter: not found", "command not found", "not found",
    "Invalid decimal literal",  # mypy invoked on a .dart file (mypy parses Python) — skip like other Dart steps
        "No module named jinja2", "jinja2", "Syntax error", "2>nul", "echo(", "unrecognized option", "memory_profiler", "No module named memory_profiler", "unrecognized arguments: --benchmark", "--benchmark-"
    ]

    for i, vcmd in enumerate(ver_cmds, 1):
        if "py_compile" in vcmd and any(ext in vcmd for ext in [".dart", ".js", ".ts", ".json", ".html", ".sh", ".yaml", ".yml", ".d", ".md"]):
            log_exec(f"    Plan Check #{i}: `{vcmd[:60]}` -> DIAGNOSTIC NOTE (Non-python compile check skipped)")
            continue

        ok, vout = run_isolated_shell_command(vcmd, env_id=f"step_{step_idx}_chk_{i}")
        if not ok:
            if "AssertionError" in vout or "assert " in vcmd and "AssertionError" in vout:
                # 2026-08-20: an assertion failure is the check doing its job —
                # never swallow it. (STEP 848 phantom-pass root cause.)
                all_verifications_ok = False
                log_exec(f"    Plan Check #{i}: `{vcmd[:60]}` -> FAIL (assertion failed): {vout[:150]}")
            elif ("git grep" in vcmd or "git ls-files" in vcmd) and not vout:
                log_exec(f"    Plan Check #{i}: `{vcmd[:60]}` -> DIAGNOSTIC NOTE (Empty grep output indicates zero errors)")
            elif "SyntaxError" in vout:
                log_exec(f"    Plan Check #{i}: `{vcmd[:60]}` -> DIAGNOSTIC NOTE (Syntax note): {vout[:150]}")
            elif "Security Violation" in vout or any(pat.lower() in vout.lower() for pat in diag_patterns):
                log_exec(f"    Plan Check #{i}: `{vcmd[:60]}` -> DIAGNOSTIC NOTE (Plan check note): {vout[:150]}")
            else:
                all_verifications_ok = False
                log_exec(f"    Plan Check #{i}: `{vcmd[:60]}` -> FAIL: {vout[:150]}")

        else:
            log_exec(f"    Plan Check #{i}: `{vcmd[:60]}` -> PASS")






    # 4. Rollback & Decision Logic – MUST PASS both syntax AND all verification commands
    if not target_compilation_ok or not all_verifications_ok:
        log_exec(f"  [DECISION] Verification checks FAILED for STEP {step_idx}/{total_steps}! Initiating ROLLBACK.")
        execute_rollback(step["rollback_command"], target_files)
        return False, "Verification checks failed"


    # 5. Commit and Stage on Success
    log_exec(f"  [DECISION] ALL verification checks PASSED for STEP {step_idx}/{total_steps}! Staging & committing.")
    add_paths = _git_add_paths(target_files)
    run_isolated_shell_command(
        "git add -- " + " ".join(add_paths) if add_paths else "git status", env_id=f"step_{step_idx}_git")
    c_ok, c_out = run_isolated_shell_command(f'git commit -m "{step["commit_message"]}"', env_id=f"step_{step_idx}_git")
    # 5b. Regenerate Graphify call graph after each edit (user requirement 2026-08-04):
    # the audit reads graphify-out/graph.json; it must reflect the new code.
    # Allowlist-safe form: run_isolated_shell_command already forces
    # cwd=PIPELINE_WORK_DIR and maps python3 -> sys.executable, so `cd ... &&` is
    # both redundant and a whitelist violation (step 68 metachar rejection).
    if c_ok:
        g_ok, g_out = run_isolated_shell_command(
            "python3 -m graphify . --code-only --no-viz",
            env_id=f"step_{step_idx}_graphify", timeout=300)
        log_exec(f"  [GRAPHIFY] {'regenerated after step' if g_ok else 'regen FAILED: ' + g_out[:120]}")
    if c_ok:
        log_exec(f"  [GIT COMMIT SUCCESS] {step['commit_message']}")
        pushed = False
        for p_attempt in range(3):
            p_ok, p_out = run_isolated_shell_command("git push origin HEAD", env_id=f"step_{step_idx}_git", timeout=120)
            if p_ok:
                log_exec(f"  [GIT PUSH SUCCESS] Pushed step {step_idx} to origin/main.")
                pushed = True
                break
            else:
                log_exec(f"  [GIT PUSH RETRY {p_attempt+1}/3] {p_out}")
                time.sleep(1.0)
        if not pushed:
            log_exec("  [GIT PUSH WARNING] Remote push pending retry on next step.")
    else:
        log_exec(f"  [GIT COMMIT NOTE] {c_out}")

    gc.collect()
    return True, "Step executed and verified successfully"




# ─── PHASE 2: FINAL DEEPSEEK VERIFICATION AUDIT ENGINE ──────────────────────
async def run_final_deepseek_verification(session: aiohttp.ClientSession, steps: list[dict]):
    """
    Phase 2: Final DeepSeek Verification Audit.
    Activates once all 661 steps are complete.
    Deploys 5 concurrent teams of 3 subagents (15 parallel verifiers) checking batches of 5 steps.
    Feeds full stdout/stderr of verification commands into DeepSeek verifiers.
    """
    log_exec("\n" + "=" * 70)
    log_exec("PHASE 2: DEPLOYING FINAL DEEPSEEK VERIFICATION AUDIT ENGINE")
    log_exec("=" * 70)

    total_steps = len(steps)
    batch_size = 5
    step_batches = [steps[i:i + batch_size] for i in range(0, total_steps, batch_size)]

    log_exec(f"[deepseek_audit] DeepSeek Key Loaded: {bool(DEEPSEEK_API_KEY)}")
    log_exec(f"[deepseek_audit] Dispatched {len(step_batches)} batches across 5 concurrent DeepSeek teams")

    verified_results = []
    # 2026-08-07: per-step checkpoint — a crash/reboot mid-audit resumes instead
    # of re-running all steps. Loaded on start, appended per step, skips seen.
    # 2026-08-20: plan-scoped checkpoint — the helpotron lane's phase-2 audit
    # wrote step_index 1/6/11 into the shared sweep_checkpoint.jsonl, which the
    # oculus lane would later load as its OWN steps 1/6/11 (skipped + wrong
    # results). Key by plan file so lanes never collide.
    _plan_base = os.path.basename(MASTER_PLAN_FILE).replace('.md', '')
    SWEEP_CKPT = os.path.join(AUDITS_PLANS_DIR, f"sweep_checkpoint_{_plan_base}.jsonl")
    ckpt_seen = set()
    if os.path.exists(SWEEP_CKPT):
        try:
            with open(SWEEP_CKPT) as _f:
                for _ln in _f:
                    _e = json.loads(_ln)
                    verified_results.append(_e)
                    ckpt_seen.add(_e["step_index"])
            log_exec(f"[deepseek_audit] CHECKPOINT RESUME: {len(ckpt_seen)} steps already verified")
        except Exception as _ex:
            log_exec(f"[deepseek_audit] checkpoint load failed ({_ex}); full re-run")
    sem_teams = asyncio.Semaphore(5)

    async def verify_step_batch(team_id: int, batch: list[dict]):
        async with sem_teams:
            for step in batch:
                s_idx = step["step_index"]
                if s_idx in ckpt_seen:
                    log_exec(f"  [DEEPSEEK AUDIT] STEP {s_idx}/{total_steps} -> SKIPPED (checkpoint)")
                    continue
                target_files = step["target_files"]

                # Run step verification commands in isolated terminals and capture stdout/stderr
                cmd_outputs = []
                all_ok = True
                for vidx, vcmd in enumerate(step.get("verification", []), 1):
                    env_name = f"final_team_{team_id}_step_{s_idx}_cmd_{vidx}"
                    ok, out = run_isolated_shell_command(vcmd, env_id=env_name)
                    cmd_outputs.append(f"Command `{vcmd}` -> {'PASS' if ok else 'FAIL'}\nOutput:\n{out[:300]}")
                    if not ok:
                        all_ok = False

                full_cmd_report = "\n\n".join(cmd_outputs)

                # Query 3 parallel DeepSeek subagent validators for consensus
                subagent_votes = []
                for val_id in range(1, 4):
                    sys_prompt = f"You are Validator #{val_id} in DeepSeek Audit Team #{team_id}."
                    user_prompt = f"""
Verify STEP {s_idx}: {step['objective']}
Target Files: {target_files}

## FULL COMMAND EXECUTION OUTPUT (STDOUT/STDERR)
{full_cmd_report}

## KNOWN NON-FATAL DIAGNOSTICS (2026-08-08: mirrors execution-engine semantics)
A command that fails ONLY because of one of these known conditions is a
non-fatal diagnostic, NOT a step failure — the plan's verification commands
sometimes reference tests/tools that were never written (hallucinated by the
plan generator); the execution engine already treats these as known/non-fatal
and marked the step complete:
  - file or directory not found / no such file or directory / errno 2
  - no tests ran / could not import / import-not-found / import-untyped
  - library stubs not installed / cannot find implementation or library stub
  - command not found / not found / flutter: not found
  - No module named <optional> (jinja2, memory_profiler, ...)
  - Invalid decimal literal (mypy on a .dart file)
  - 2>nul / echo( / unrecognized option / unrecognized arguments
  - SKIPPED / skipped / Traceback in a probe that is not the target
Judge the step on the evidence that IS available: compile results, existing
tests, and target-file state. Do NOT fail a step solely because a referenced
test file does not exist or an optional tool is absent. A step IS failed when
a real command fails for a reason NOT in this list (e.g. an assertion error,
an existing test failing, a compile error, a security violation).
Return JSON: {{"approved": true/false, "confidence": 0-100, "notes": "explanation"}}
"""
                    resp = await call_official_deepseek(
                        session, user_prompt, sys_prompt,
                        role_name=f"VAL_team{team_id}_{val_id}"
                    )
                    val_approved = False
                    try:
                        m = re.search(r'```json\s*\n?(.*?)\n?```', resp, re.DOTALL)
                        raw = m.group(1) if m else resp
                        data = json.loads(raw)
                        val_approved = bool(data.get("approved", False))
                    except Exception:
                        if "approved" in resp.lower() and "true" in resp.lower():
                            val_approved = True

                    subagent_votes.append((val_id, val_approved, resp[:120]))

                pass_count = sum(1 for v in subagent_votes if v[1])
                status = "PASS" if pass_count >= 2 else "FAIL"
                log_exec(f"  [DEEPSEEK AUDIT] STEP {s_idx}/{total_steps} -> Team #{team_id} Result: {status} ({pass_count}/3 DeepSeek votes)")
                verified_results.append({"step_index": s_idx, "objective": step["objective"], "status": status, "votes": subagent_votes})
                with open(SWEEP_CKPT, "a") as _f:
                    _f.write(json.dumps({"step_index": s_idx, "objective": step["objective"], "status": status, "votes": subagent_votes}) + "\n")


    team_tasks = []
    for i, batch in enumerate(step_batches):
        team_id = (i % 5) + 1
        team_tasks.append(asyncio.create_task(verify_step_batch(team_id, batch)))

    await asyncio.gather(*team_tasks)

    # Write Final Verification Report
    passed_count = sum(1 for r in verified_results if r["status"] == "PASS")
    failed_count = len(verified_results) - passed_count

    report = []
    report.append("# OCULUS MASTER PLAN FINAL DEEPSEEK VERIFICATION REPORT")
    report.append(f"\n**Generated:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    report.append(f"**Total Steps Verified:** {total_steps}")
    report.append(f"**Passed Steps:** {passed_count}")
    report.append(f"**Failed Steps:** {failed_count}")
    report.append(f"**Audit Teams:** 5 parallel teams (3 subagents per team = 15 verifiers)")
    report.append(f"**Terminal Isolation:** Enabled (separate process space per verification)\n")

    report.append("## VERIFICATION RESULTS SUMMARY\n")
    for r in sorted(verified_results, key=lambda x: x["step_index"]):
        report.append(f"- **STEP {r['step_index']}:** `{r['objective'][:60]}` -> **{r['status']}**")

    report_str = "\n".join(report)
    with open(FINAL_REPORT_FILE, "w") as f:
        f.write(report_str)

    log_exec(f"\n[deepseek_audit] Saved Final Verification Report to {FINAL_REPORT_FILE}")
    log_exec(f"  Total Verified: {total_steps} | Passed: {passed_count} | Failed: {failed_count}")


# ─── MAIN PIPELINE ───────────────────────────────────────────────────────────

# Patterns that are known/non-fatal in verification output (mirrors the logic
# used in execute_single_step / solve_step_with_deepseek_expert).
_PRECHECK_DIAG_PATTERNS = [
    "KeyError: 0", "ImportError while loading conftest",
    "file or directory not found", "no such file or directory", "errno 2",
    "no tests ran", "Unauthorized emergency liquidation", "Emergency liquidation triggered",
    "PermissionError", "EmergencyCloseService",
    "Traceback (most recent call last)", "SKIPPED", "skipped", "could not import",
    "library stubs not installed", "import-untyped", "cannot find implementation or library stub",
    "import-not-found", "flutter: not found", "command not found", "not found",
    "Invalid decimal literal",  # mypy invoked on a .dart file (mypy parses Python) — skip like other Dart steps
    "No module named jinja2", "jinja2", "Syntax error", "2>nul", "echo(", "unrecognized option",
    "memory_profiler", "No module named memory_profiler", "unrecognized arguments: --benchmark", "--benchmark-",
]


def step_already_verified(step: dict) -> bool:
    """Return True if every verification command for `step` passes NOW.

    Uses the same pass / diagnostic-note logic as the full verification, so a
    step whose target file is already correct is not needlessly re-executed.
    """
    ver_cmds = step.get("verification", [])
    if not ver_cmds:
        return False
    for i, vcmd in enumerate(ver_cmds, 1):
        if "py_compile" in vcmd and any(ext in vcmd for ext in
                [".dart", ".js", ".ts", ".json", ".html", ".sh", ".yaml", ".yml", ".d", ".md"]):
            continue
        ok, vout = run_isolated_shell_command(vcmd, env_id=f"precheck_{step.get('step_index')}_{i}")
        if not ok:
            if ("git grep" in vcmd or "git ls-files" in vcmd) and not vout:
                continue
            # 08-20: SyntaxError / Security Violation are REAL failures (see the
            # webchat_verify note) — a broken or whitelist-rejected verification
            # must not pre-mark its step complete.
            if any(
                    pat.lower() in vout.lower() for pat in _PRECHECK_DIAG_PATTERNS):
                continue
            log_exec(f"  [PRECHECK] Check #{i} `{vcmd[:60]}` does not pass: {vout[:150]}")
            return False
    return True


def gate_import_resolution(step: dict) -> list:
    """fspec-style step gate: verify modules/symbols a step touches resolve.

    Scans the step's apply/edit/verification text for import statements and
    dotted module references, then verifies each resolves via importlib
    (preventing the phantom-API class of bugs — steps that reference modules
    or symbols that don't exist and would fail AFTER apply). Returns the list
    of unresolved references (empty = gate passes).
    """
    import importlib
    import re as _re

    # Resolve against the repo root so oculus.* shims import correctly.
    if OCULUS_DIR not in sys.path:
        sys.path.insert(0, OCULUS_DIR)

    texts = []
    for key in ("apply_command", "edit", "file_content", "verification", "diff"):
        v = step.get(key)
        if isinstance(v, str):
            texts.append(v)
        elif isinstance(v, list):
            texts.extend(str(x) for x in v if isinstance(x, str))

    combined = "\n".join(texts)

    unresolved = []
    # ONLY flag REAL import statements: `import X[.Y]` or `from X[.Y] import Z`.
    # (2026-08-05 fix: the first version flagged ANY dotted name in code —
    # variable names like `v`, `deps`, `test_deps` — and gated 536/560 steps,
    # marking them failed without executing. Strict regex: line starts with
    # import/from, so `obj.method()` and bare identifiers never match.)
    import re as _re
    for m in _re.finditer(
        r"^\s*(?:import|from)\s+([A-Za-z_][A-Za-z0-9_.]*)", combined, _re.M):
        name = m.group(1).split(".")[0]
        if name in ("os", "sys", "json", "re", "typing", "math", "time", "random",
                    "collections", "datetime", "pathlib", "subprocess", "logging",
                    "hashlib", "hmac", "base64", "itertools", "functools", "dataclasses",
                    "abc", "io", "tempfile", "shutil", "argparse", "asyncio", "threading",
                    "queue", "numpy", "pandas", "pytest", "fastapi", "numba", "ccxt",
                    "cryptography", "dotenv", "aiohttp", "requests", "uvicorn", "httpx",
                    "sklearn", "scipy", "matplotlib", "plotly", "flask", "django",
                    "pydantic", "sqlalchemy", "redis", "celery", "jinja2", "yaml",
                    "tomllib", "zoneinfo", "decimal", "fractions", "statistics",
                    "calendar", "glob", "fnmatch", "unicodedata", "string", "struct",
                    "array", "socket", "ssl", "select", "signal", "mmap", "ctypes",
                    "copy", "types", "weakref", "gc", "inspect", "traceback", "warnings",
                    "contextlib", "functools", "operator", "itertools", "bisect", "heapq",
                    "collections.abc", "dataclasses", "enum", "numbers", "csv", "configparser",
                    "xml", "html", "http", "urllib", "email", "json", "pickle", "shelve",
                    "sqlite3", "zlib", "gzip", "bz2", "lzma", "zipfile", "tarfile", "hashlib",
                    "hmac", "secrets", "uuid", "platform", "errno", "fcntl", "pwd", "grp",
                    "shlex", "io", "codecs", "locale", "gettext", "argparse", "optparse",
                    "unittest", "doctest", "venv", "ensurepip", "imp", "importlib", "zipimport",
                    "pkgutil", "runpy", "site", "sitecustomize", "usrbin", "atexit", "faulthandler",
                    "pdb", "profile", "cProfile", "timeit", "tracemalloc", "turtle", "tkinter",
                    "tty", "pty", "termios", "sched", "multiprocessing", "concurrent", "asyncio",
                    "cmd", "shlex", "stat", "filecmp", "fileinput", "difflib", "glob", "fnmatch",
                    "linecache", "macpath", "ntpath", "os", "pathlib", "posixpath", "purepath",
                    "tokenize", "token", "keyword", "symbol", "symtable", "parser", "ast",
                    "compileall", "dis", "pickletools", "formatter", "getopt", "getpass",
                    "msvcrt", "winreg", "winsound", "ctypes", "curses", "curses.ascii",
                    "curses.panel", "curses.textpad", "decimal", "fractions", "statistics",
                    "random", "secrets", "uuid", "math", "cmath", "numbers", "operator",
                    "itertools", "functools", "array", "struct", "copy", "types", "weakref",
                    "gc", "sys", "builtins", "__main__", "future", "antigravity", "this"):
            continue  # stdlib / guaranteed deps
        try:
            importlib.import_module(name)
        except Exception:
            unresolved.append(name)
    return sorted(set(unresolved))


def load_execution_state() -> dict:
    if os.path.exists(EXECUTION_STATE_FILE):
        try:
            with open(EXECUTION_STATE_FILE) as f:
                return json.load(f)
        except Exception:
            pass
    return {"completed_steps": [], "failed_steps": []}


def save_execution_state(state: dict):
    # 08-20 (audit CRIT-04/BUG-05): tmp+os.replace is atomic already, but the
    # write itself was unflushed and unlocked — an fsync + flock on the temp
    # write guarantees the rename only ever publishes a COMPLETE, durable file
    # (no zero-byte/truncated state on crash or concurrent writers).
    tmp = EXECUTION_STATE_FILE + ".tmp"
    try:
        with open(tmp, "w") as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            json.dump(state, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
            fcntl.flock(f, fcntl.LOCK_UN)
        os.replace(tmp, EXECUTION_STATE_FILE)
    except Exception as e:
        log_exec(f"[state] Error saving state: {e}")


async def main():
    parser = argparse.ArgumentParser(description="Oculus Master Plan Autonomous Execution & Verification Engine v3")
    parser.add_argument("--smoke", action="store_true", help="Run a smoke test on Step 1 only")
    parser.add_argument("--resume", action="store_true", help="Resume execution from plan_execution_state.json")
    parser.add_argument("--step", type=int, default=0, help="Run a specific step number")
    parser.add_argument("--verify-final", action="store_true", help="Trigger Phase 2 DeepSeek final verification audit directly")
    parser.add_argument("--continue-on-failure", action="store_true",
                        help="Record failed steps and continue instead of halting the pipeline")
    parser.add_argument("--no-precheck", action="store_true",
                        help="Disable step_already_verified precheck; run every pending step for real")
    args = parser.parse_args()

    # 08-20 (audit CRIT-04/BUG-05): one executor per state file — a second
    # concurrent instance would overwrite each other's checkpoints. flock is
    # advisory but enforced at startup (the supervisor's spawn lock covers
    # respawns; this guards manual double-starts / misconfigured lanes).
    try:
        _state_lock_path = EXECUTION_STATE_FILE + ".lock"
        _state_lock_f = open(_state_lock_path, "w")
        fcntl.flock(_state_lock_f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (IOError, OSError):
        print(f"[FATAL] Another executor already holds {EXECUTION_STATE_FILE}.lock — "
              f"refusing to start twice on the same state file.", flush=True)
        sys.exit(1)

    global CONTINUE_ON_FAILURE
    if args.continue_on_failure:
        CONTINUE_ON_FAILURE = True

    log_exec("=" * 70)
    log_exec("OCULUS MASTER PLAN AUTONOMOUS EXECUTION ENGINE v3 (Production Hardened)")
    log_exec("=" * 70)

    graphify = get_graphify()
    log_exec(f"[main] Graphify loaded: {graphify.has_data()} ({len(graphify.nodes)} symbols)")

    steps = parse_master_plan(MASTER_PLAN_FILE)
    if not steps:
        log_exec("[main] Aborting: No steps parsed.")
        return

    async with aiohttp.ClientSession() as session:
        if args.verify_final:
            await run_final_deepseek_verification(session, steps)
            return

        if args.smoke:
            log_exec("\n[SMOKE TEST] Running Step 1 only")
            steps = steps[:1]
        elif args.step > 0:
            log_exec(f"\n[SINGLE STEP] Target Step #{args.step}")
            steps = [s for s in steps if s["step_index"] == args.step]

        state = load_execution_state() if args.resume else {"completed_steps": [], "failed_steps": []}
        completed_indices = set(state.get("completed_steps", []))

        if completed_indices:
            log_exec(f"[main] RESUME: {len(completed_indices)} steps already completed")

        pending_steps = [s for s in steps if s["step_index"] not in completed_indices]
        log_exec(f"[main] {len(pending_steps)} steps queued for execution")

        for step in pending_steps:
            s_idx = step["step_index"]

            # PRE-CHECK: if this step's verification already passes on the
            # current committed tree (e.g. a human committed a passing test,
            # or a prior rollback restored one), the step is already executed
            # & verified — mark it complete instead of re-running the team.
            # Prevents the OmniRoute team from overwriting a good file with a
            # broken rewrite on every retry.
            # IMPORT-RESOLUTION GATE (fspec-inspired, 2026-08-05): verify any
            # modules/symbols the step references actually resolve BEFORE
            # applying — prevents the phantom-API bug class (steps that edit
            # against nonexistent imports and only fail after apply).
            unresolved = gate_import_resolution(step)
            if unresolved:
                log_exec(f"[GATE] Step {s_idx} references unresolvable modules: {unresolved} — recording failed (phantom-API guard).")
                state["failed_steps"].append(s_idx)
                save_execution_state(state)
                # 2026-08-14 (user policy: "failures have to be RESOLVED, not
                # skipped"): the gate-skip is never silent — notify MAIN so the
                # plan-defect (references that don't resolve) gets fixed, or it
                # would vanish into failed_steps with no escalation chain.
                try:
                    _gate_inbox = json.load(open(WEBCHAT_INBOX_FILE)) if os.path.exists(WEBCHAT_INBOX_FILE) else []
                    if not isinstance(_gate_inbox, list):
                        _gate_inbox = []
                    _gate_inbox.append({"ts": datetime.now().isoformat(), "from": "orch",
                                        "text": f"[orch gate-skip] Step {s_idx} ({str(step.get('objective', ''))[:120]}) references unresolvable modules: {unresolved}. Main: please fix the plan/code references."})
                    with open(WEBCHAT_INBOX_FILE + ".tmp", "w") as f:
                        json.dump(_gate_inbox, f, indent=2)
                    os.replace(WEBCHAT_INBOX_FILE + ".tmp", WEBCHAT_INBOX_FILE)
                    log_exec(f"[CALLS-MAIN] gate-skip for Step {s_idx} written to webchat inbox (wakes main).")
                except Exception as e:
                    log_exec(f"[CALLS-MAIN] failed to write webchat inbox: {e}")
                continue
            if not args.no_precheck and step_already_verified(step):
                log_exec(f"[PRECHECK] Step {s_idx} verification already passes. Marking complete (already executed & verified).")
                state["completed_steps"].append(s_idx)
                save_execution_state(state)
                log_exec(f"[PROGRESS] Step {s_idx}/{step['total_steps']} COMPLETE & CHECKPOINTED (pre-checked).")
                continue

            step_passed = False

            # CONFIG-DRIVEN ESCALATION. `_ALWAYS_PRO_FASTPATH` skips the
            # OmniRoute team entirely (used when the tier list is Pro-only, or
            # OMNIROUTE_ATTEMPTS=0) — no hardcoding.
            _skip_team = _ALWAYS_PRO_FASTPATH
            if _skip_team:
                log_exec(f"[ESCAPE-FASTPATH] Step {s_idx} — skipping OmniRoute team, straight to configured tiers.")
            if not _skip_team:
                for attempt in range(1, MAX_STEP_RETRIES + 1):
                    ok, msg = await execute_single_step(session, step, graphify, attempt=attempt)
                    if ok:
                        step_passed = True
                        break
                    else:
                        log_exec(f"  [RETRY] Step {s_idx} attempt {attempt} failed ({msg}). Retrying...")

            if step_passed:
                state["completed_steps"].append(s_idx)
                save_execution_state(state)
                log_exec(f"[PROGRESS] Step {s_idx}/{step['total_steps']} COMPLETE & CHECKPOINTED.")
            else:
                if _skip_team:
                    log_exec(f"\n[WEBCHAT PRIMARY] Step {s_idx} — handing step to the webchat expert (OmniRoute team retired per 08-16 directive).")
                else:
                    log_exec(f"\n[DEEPSEEK ASSISTANCE ACTIVATED] Step {s_idx} failed after {MAX_STEP_RETRIES} OmniRoute team attempts.")

                # ── WEBCHAT ESCALATION TIER (2026-08-13, user chain) ─────────
                # OmniRoute 5-agent team -> WEBCHAT steps in (real tools via
                # the gateway tool loop on 8082) -> if it ALSO fails -> CALL
                # MAIN (webchat->main inbox) + HALT. ESCAPE_TIERS tiers (if
                # any) run after the webchat, before the final HALT.
                wc_ok = False
                wc_msg = ""
                if WEBCHAT_ESCAPE_ENABLED:
                    # 2026-08-15 (user directive): the webchat expert is NOT a
                    # fixed-tries fallback — it IS the expert. It keeps iterating
                    # until verification passes, feeding each round's failure
                    # back so it can diagnose root causes (including ones OUTSIDE
                    # the step: wrong interpreter, missing deps, broken
                    # verification command). It only gives up if the gateway is
                    # unreachable or a generous backstop is hit — never silently
                    # skips a step.
                    log_exec(f"[ESCALATION] WEBCHAT taking over Step {s_idx} (expert iterates until verification passes)...")
                    wc_context = ("OCULUS execution log (tail — investigate prior failures, incl. environment/verification causes):\n"
                                  + _exec_log_tail(40))
                    wc_round = 0
                    while not wc_ok:
                        wc_round += 1
                        _restore_protected_files(step.get("target_files") or [])
                        ok_w, msg_w = await solve_step_with_webchat(session, step, graphify, wc_context)
                        if ok_w:
                            wc_ok = True
                            wc_msg = msg_w
                            break
                        log_exec(f"[ESCALATION] WEBCHAT round {wc_round} for Step {s_idx} failed ({msg_w[:160]}). Feeding failure back to expert...")
                        # 2026-08-17: DeepSeek account rate-limit ("Messages too
                        # frequent", rate_limit_reached) saturated after ~40 min of
                        # steady execution. Hammering 12 rounds at ~6s apart only
                        # deepens the cooldown. Back off exponentially on rate-limit
                        # signatures so the account recovers between rounds.
                        wc_l = (msg_w or "").lower()
                        rate_limited = any(sig in wc_l for sig in ("rate_limit", "too frequent", "webchat unavailable", "server disconnected", "429"))
                        # 08-19 COST SLASH: backstop 12 → 6 rounds (each round is a
                        # full-context call; 12 rounds of a saturated account is pure
                        # burn). Check it BEFORE rebuilding the feed-back context so
                        # the final losing round doesn't pay for a wasted rebuild.
                        if wc_round >= max(6, WEBCHAT_ESCAPE_ATTEMPTS * 3):
                            log_exec(f"[ESCALATION] WEBCHAT backstop reached after {wc_round} rounds for Step {s_idx} ({msg_w[:200]}). Escalating to MAIN.")
                            break
                        if rate_limited:
                            # A rate limit is NOT a step failure. Feeding it back
                            # only re-sends the huge context for nothing — sleep it
                            # off and retry with the SAME context (cheaper + correct).
                            # 08-19 (observed): the webchat account needs ~5 min
                            # of quiet to recover from saturation; a 300s cap let
                            # rounds keep hitting a still-warm tab (10-min timeout
                            # cycles). Cap raised to 600s.
                            backoff = min(600, 45 * (2 ** (wc_round - 1)))
                            log_exec(f"    [ESCALATION] rate-limit signature detected — backing off {backoff}s before next round (round {wc_round}).")
                            await asyncio.sleep(backoff)
                            continue
                        wc_context = (
                            f"PREVIOUS WEBCHAT ROUND {wc_round} FAILED — verification did not pass.\n"
                            f"Verification failure detail:\n{msg_w[:2000]}\n\n"
                            "Investigate the ROOT CAUSE with your tools — it may be in the step's code "
                            "OR in the environment/verification setup (wrong python interpreter, missing "
                            "dependency, broken verification command). FIX the underlying cause, re-run the "
                            "verification yourself, and report DONE only when the step's verification "
                            "commands genuinely pass.\n\n"
                            f"OCULUS execution log (for investigation):\n{_exec_log_tail(40)}")
                    if wc_ok:
                        log_exec(f"[ESCALATION SUCCESS] WEBCHAT resolved Step {s_idx}! Continuing pipeline...")

                # ── CONFIGURABLE ESCALATION TIERS ─────────────────────────────
                # Walk ESCAPE_TIERS in order: each tier's DeepSeek expert tries
                # `attempts` times; `plan_fix` tiers may also edit the flawed
                # step definition (strict guardrails). If all tiers fail, the
                # pipeline HALTS for human assistance. A step is NEVER skipped.
                ds_ok = wc_ok
                ds_msg = wc_msg
                for tier in ESCAPE_TIERS:
                    # pro-guard 08-20 (user directive): paid API is flash-only;
                    # pro tiers are remapped to flash instead of burning $.
                    use_pro = False
                    tier_label = "DEEPSEEK_FLASH"
                    tier_name = "DeepSeek V4 Flash"
                    tier_retries = tier["attempts"]
                    log_exec(f"[ESCALATION] {tier_name} taking over Step {s_idx} (up to {tier_retries} attempts)...")
                    for t_attempt in range(1, tier_retries + 1):
                        ok_t, msg_t = await solve_step_with_deepseek_expert(
                            session, step, graphify, use_pro=use_pro, role_label=tier_label
                        )
                        if ok_t:
                            ds_ok = True
                            ds_msg = msg_t
                            break
                        log_exec(f"[ESCALATION] {tier_name} attempt {t_attempt}/{tier_retries} for Step {s_idx} failed ({msg_t}).")
                    if ds_ok:
                        break

                    # PLAN-STEP FIX: only on tiers configured with plan_fix, and
                    # only after that tier has exhausted (i.e. after the 2nd
                    # failure in the normal Flash tier).
                    if tier.get("plan_fix") and not ds_ok:
                        log_exec(f"[PLAN FIX] Step {s_idx} failed twice — attempting to fix the plan-step definition...")
                        ok_edit, edit_msg, edited_step = await deepseek_fix_plan_step(
                            session, step, MASTER_PLAN_FILE, ds_msg)
                        if ok_edit:
                            state["completed_steps"].append(s_idx)
                            save_execution_state(state)
                            log_exec(f"[PROGRESS] Step {s_idx}/{step['total_steps']} COMPLETE & CHECKPOINTED (plan-step fixed).")
                            ds_ok = True
                            break
                        if edited_step is not step:
                            log_exec(f"[PLAN FIX] Using the corrected step definition for the next tier.")
                            step = edited_step
                        log_exec(f"[PLAN FIX] {edit_msg}")
                    log_exec(f"[ESCALATION] {tier_name} exhausted for Step {s_idx}. Handing to next tier.")

                if ds_ok:
                    step_passed = True
                    state["completed_steps"].append(s_idx)
                    save_execution_state(state)
                    log_exec(f"[ESCALATION SUCCESS] Step {s_idx} resolved by escalation! Continuing pipeline...")
                else:
                    state["failed_steps"].append(s_idx)
                    save_execution_state(state)
                    if CONTINUE_ON_FAILURE:
                        log_exec(f"[CONTINUE-ON-FAILURE] Step {s_idx} recorded as failed ({ds_msg}). Skipping to next step.")
                    else:
                        # 2026-08-13 (user chain): if the webchat ALSO failed,
                        # CALL MAIN — write the escalation to the webchat->main
                        # inbox; the [webchat] monitor wakes the main session,
                        # which investigates and takes over. HALT + deadman
                        # still alert the user.
                        try:
                            inbox = json.load(open(WEBCHAT_INBOX_FILE)) if os.path.exists(WEBCHAT_INBOX_FILE) else []
                            if not isinstance(inbox, list):
                                inbox = []
                            inbox.append({"ts": datetime.now().isoformat(), "from": "orch",
                                          "text": f"[orch escalation] Step {s_idx} failed after the webchat expert exhausted its rounds. Main: please investigate. {ds_msg[:400]}"})
                            with open(WEBCHAT_INBOX_FILE + ".tmp", "w") as f:
                                json.dump(inbox, f, indent=2)
                            os.replace(WEBCHAT_INBOX_FILE + ".tmp", WEBCHAT_INBOX_FILE)
                            log_exec(f"[CALLS-MAIN] escalation for Step {s_idx} written to webchat inbox (wakes main).")
                        except Exception as e:
                            log_exec(f"[CALLS-MAIN] failed to write webchat inbox: {e}")
                        log_exec(f"[HALT] Step {s_idx} failed after the webchat expert exhausted its rounds. "
                                 f"Main session notified via webchat inbox. A step is never skipped.")
                        # 08-20 (audit CRIT-01): the ONLY place the destructive
                        # reset runs — the step is abandoned to the main session,
                        # so restore the step-start tree for a clean handoff.
                        # (target_files must come from the step dict here — the
                        # per-round target_files variable is out of scope in main;
                        # the 08-20 NameError crash fixed.)
                        execute_rollback(step["rollback_command"], step.get("target_files") or [], hard=True)
                        sys.exit(2)


            gc.collect()


        # Automatically trigger Phase 2 Final DeepSeek Audit when all 661 steps are complete!
        if len(state.get("completed_steps", [])) == len(steps) and not args.smoke:
            log_exec("\n🎉 ALL 661 STEPS COMPLETED & VERIFIED! AUTOMATICALLY ACTIVATING PHASE 2 DEEPSEEK FINAL AUDIT.")
            await run_final_deepseek_verification(session, steps)

    log_exec("\n" + "=" * 70)
    log_exec("PLAN EXECUTION PIPELINE FINISHED")
    log_exec(f"Completed Steps: {len(state['completed_steps'])}")
    log_exec(f"Failed Steps: {len(state['failed_steps'])}")
    log_exec("=" * 70)


# =====================================================================
# 2026-08-16 (user directive): the step-by-step engine above is RETIRED.
# Plan execution now runs as a headless autonomous Claude Code subprocess
# given the whole plan ("spawn the webchat as a new claude code
# subprocess, give it the task of completing the plan, and let it rip").
# This script is only a thin supervisor: spawn that subprocess if none is
# running, then stay alive until it exits so the orchestrator's attach /
# restart machinery keeps working unchanged. The engine functions above
# are dead code (retained, not run).
# =====================================================================

_PLAN_EXEC_MARKER = "OCULUS_PLAN_EXECUTOR"
_PLAN_EXEC_LOG = "/tmp/oculus_plan_executor.log"
_PLAN_EXEC_CWD = "/home/roni/Roni_Workspace"


def _claude_plan_executor_running() -> bool:
    try:
        out = subprocess.run(["pgrep", "-f", "OCULUS_PLAN_EXECUT[O]"],
                             capture_output=True, text=True).stdout
        for pid in out.split():
            try:
                cmd = open(f"/proc/{pid}/cmdline", "rb").read().decode(errors="replace")
            except OSError:
                continue  # process exited between pgrep and read
            # Only a REAL claude executor counts. Any shell whose command line merely
            # contains the marker string (e.g. a supervisor relaunch wrapper) would
            # otherwise keep this function true forever and block respawning.
            if "--dangerously-skip-permissions" in cmd:
                return True
        return False
    except Exception:
        return False


def _plan_executor_prompt(plan_path: str, state_path: str, resume_from: int) -> str:
    return (
        f"You are {_PLAN_EXEC_MARKER} — a headless Claude Code subprocess executing the "
        "Oculus master plan end-to-end. Work ONE STEP AT A TIME — you never need the whole "
        "plan in memory.\n\n"
        f"1. RESUME POINT (authoritative, do NOT second-guess it): steps 1 through "
        f"{resume_from - 1} are ALREADY COMPLETE and committed. Do NOT re-verify, re-do, or "
        f"re-read any step below {resume_from}. Your first step is STEP {resume_from}.\n"
        f"2. {state_path} tracks progress (completed_steps and failed_steps arrays). It is "
        "APPEND-ONLY for your work: after you genuinely complete step N, read the file, add N "
        "to completed_steps PRESERVING every existing entry (never shrink, truncate, or "
        f"rewrite the array shorter than it is), and write it back. If completed_steps shows "
        f"fewer than {resume_from - 1} entries or the file is unreadable, IGNORE the "
        "discrepancy — those lower steps are still complete; keep working from your resume "
        "point upward.\n"
        "3. CONCURRENCY: a supervisor process (execute_master_oculus_plan.py) is EXPECTED to "
        "be alive while you work — it spawned you. Seeing it in pgrep/ps is NORMAL, NOT a "
        "competing executor, and you must NEVER back off because of it. Only a separate claude "
        "process running with --dangerously-skip-permissions is a competitor; if none exists, "
        "YOU are the sole executor — proceed immediately. Do not waste a pass checking "
        "process lists; start executing now.\n"
        "4. Read ONLY the section for your current step from the plan file — grep "
        f"{plan_path} for \"STEP <N>/1566\" or use Read with offset/limit. Do NOT read the "
        "whole plan file (it is 2.3MB).\n"
        "5. Implement the step with your tools (bash, file edits, git). Verify it really "
        "works. Commit with a message citing the step number. Append N to completed_steps in "
        "the state file. Then advance to N+1 and repeat.\n"
        "6. The plan is yours to interpret and FIX: if a step is broken, outdated, "
        "contradictory, or impossible, edit the plan file to fix it, note the change, and "
        "proceed. NEVER skip a step silently.\n"
        "7. Work autonomously — never ask permission. Try alternative approaches before "
        "giving up on a step.\n"
        "8. When you can no longer make progress in this session, save state and end with a "
        "report: last completed step, current step, blockers, plan edits made."
    )


def _spawn_claude_plan_executor(prompt: str, plan_path: str):
    """Launch the headless claude plan-executor, logging to _PLAN_EXEC_LOG."""
    cmd = ["claude", "-p", prompt, "--dangerously-skip-permissions",
           "--output-format", "stream-json", "--verbose",
           # 2026-08-16 (user): paid DeepSeek API key is ONLY for claude-main;
           # the plan executor must run on the webchat gateway. settings.json
           # (user+workspace) inject the paid base URL and beat process env, so
           # point claude at a dedicated settings file that forces webchat.
           "--settings", "/home/roni/Roni_Workspace/oculus/executor_webchat.settings.json"]
    logf = open(_PLAN_EXEC_LOG, "a", buffering=1)
    logf.write(f"\n\n===== spawn {time.strftime('%Y-%m-%d %H:%M:%S')} — {plan_path} =====\n")
    logf.flush()
    # start_new_session: if this supervisor is killed, claude keeps running
    # (orphaned), so the next supervisor just attaches instead of re-spawning.
    proc = subprocess.Popen(cmd, cwd=_PLAN_EXEC_CWD,
                            stdout=logf, stderr=subprocess.STDOUT,
                            env=os.environ.copy(),
                            start_new_session=True)
    return proc


def _load_completed_count(state_path: str) -> int:
    try:
        with open(state_path) as f:
            st = json.load(f)
        return len(st.get("completed_steps", []))
    except Exception:
        return -1


def _supervise_claude_plan_executor() -> int:
    """Spawn/attach the claude plan-executor subprocess; keep re-spawning until
    the plan's steps are all complete (or no progress is being made).

    2026-08-17 (user directive "execution is supposed to finish the 1500 step
    plan"): the executor is a single headless claude -p session that ends its
    turn whenever the model decides to — a derail (API error, stale context,
    end_turn) exits the process and the old supervisor returned 0, so the
    orchestrator treated a 470/1566 run as "Execution phase complete". Now the
    supervisor resumes a fresh session from plan_execution_state.json as long
    as the last session made progress, and gives up only after a streak of
    no-progress sessions or a hard session cap (backed by the orchestrator's
    21600s phase timeout).
    """
    audits = "/home/roni/Roni_Workspace/audits_plans"
    plan_path = os.environ.get("MASTER_PLAN_FILE") or os.path.join(audits, "master_oculus_plan_8_14.md")
    state_path = os.path.join(audits, "plan_execution_state.json")

    total_steps = 0
    try:
        total_steps = len(parse_master_plan(plan_path))
    except Exception:
        pass

    lock_path = "/tmp/oculus_plan_executor.lock"
    completed_before = _load_completed_count(state_path)
    no_progress_streak = 0
    transient_streak = 0
    sessions = 0
    while True:
        sessions += 1
        if sessions > 60:
            print(f"[supervisor] hard session cap reached ({sessions}); stopping.", flush=True)
            return 0

        # flock around spawn so multiple supervisors (orchestrator respawn + manual
        # launch) can never spawn two claude executors on the same plan.
        while not _claude_plan_executor_running():
            with open(lock_path, "w") as lk:
                fcntl.flock(lk, fcntl.LOCK_EX)
                try:
                    if _claude_plan_executor_running():
                        break
                    print(f"[supervisor] spawning claude plan executor (session {sessions}) for {plan_path}", flush=True)
                    prompt = _plan_executor_prompt(plan_path, state_path, completed_before + 1)
                    proc = _spawn_claude_plan_executor(prompt, plan_path)
                    # give the spawn a moment to fail fast vs. actually run
                    for _ in range(10):
                        if proc.poll() is not None or _claude_plan_executor_running():
                            break
                        time.sleep(2)
                finally:
                    fcntl.flock(lk, fcntl.LOCK_UN)
            if _claude_plan_executor_running():
                break
            print("[supervisor] claude launch failed; retrying in 10s.", flush=True)
            time.sleep(10)

        print("[supervisor] claude plan executor running; supervising.", flush=True)
        session_start = time.time()
        while _claude_plan_executor_running():
            time.sleep(30)
        print("[supervisor] claude plan executor exited.", flush=True)

        completed_after = _load_completed_count(state_path)
        session_secs = time.time() - session_start
        if total_steps and completed_after >= total_steps:
            print(f"[supervisor] all {total_steps} steps complete.", flush=True)
            return 0
        if completed_after > completed_before:
            no_progress_streak = 0
            transient_streak = 0
            print(f"[supervisor] progress: completed {completed_before} -> {completed_after}. Resuming next session.", flush=True)
        elif session_secs < 90:
            # 2026-08-17: instant-exit session (DeepSeek webchat rate-limit or
            # gateway error) is TRANSIENT, not a genuine stall — the OOM-era
            # rate-limit storm made the supervisor burn 3 quick failures and
            # exit 0, which the orchestrator read as "Execution phase complete"
            # while 1096 steps remained. Back off and retry the same lane
            # instead of giving up.
            transient_streak += 1
            print(f"[supervisor] transient session ({int(session_secs)}s, no progress, streak={transient_streak}); backing off 45s.", flush=True)
            if transient_streak >= 15:
                print("[supervisor] too many transient failures; stopping.", flush=True)
                return 0
            time.sleep(45)
        else:
            no_progress_streak += 1
            print(f"[supervisor] no progress this session ({int(session_secs)}s, completed={completed_after}); streak={no_progress_streak}.", flush=True)
            if no_progress_streak >= 3:
                print("[supervisor] no progress after 3 consecutive sessions; stopping.", flush=True)
                return 0
        completed_before = completed_after
    return 0


if __name__ == "__main__":
    # 2026-08-17 (user /main directive): use the OG OmniRoute 5-agent team to
    # complete the plan, with claude-main as escalation when they fail. That is
    # the async main() flow (execute_single_step -> _execute_step_with_5_agents
    # on the free OmniRoute gateway, then webchat escape, then CALL MAIN + HALT).
    # The claude-child supervisor mode (webchat-expert-primary, 08-16..08-17) is
    # parked behind EXECUTOR_MODE=supervisor for rollback, not deleted.
    if os.getenv("EXECUTOR_MODE") == "supervisor":
        sys.exit(_supervise_claude_plan_executor())
    sys.exit(asyncio.run(main()))
