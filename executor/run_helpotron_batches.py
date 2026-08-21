#!/usr/bin/env python3
"""run_helpotron_batches.py — batch executor for the helpotron agentic
remediation master plan (2026-08-21, user order: "get gemini webchat on it").

The plan is a JSON with 10 batches (BATCH-01..10). Each batch carries:
  files_affected[]  (path / operation / line ranges / before+after snippets)
  atomic_remediation_guide[]   (ordered implementation steps)
  verification_commands[]      (acceptance tests — must ALL genuinely pass)
  rollback_procedure           (description / commands / verification_commands)

Execution: ONE gemini webchat call per batch (the expert implements the whole
batch with its tools), then the LOCAL verification commands run in the
helpotron repo root with the helpotron venv python. All pass -> shrink guard ->
git add + commit + push -> atomic state checkpoint. Fail -> rollback + up to
BACKSTOP_ROUNDS feedback rounds (rate-limit backoff 45*2^(r-1) cap 600s) ->
recorded failed + notify main, continue. Free-skip: batch whose verification
commands already ALL pass costs zero LLM calls.

This is a SEPARATE pipeline from the oculus plan: own state file
(helpotron_execution_state.json + flock, kept alive for the whole run), own
repo (/home/roni/Roni_Workspace/helpotron), own lane (gemini 8085). The oculus
batch executor keeps running on the deepseek lane untouched.

Usage:  python3 run_helpotron_batches.py [--dry-run]
Env:    HELPOTRON_DIR, HELPOTRON_PLAN, HELPOTRON_STATE, HELPOTRON_LOG,
        WEBCHAT_API_BASE (gemini lane), WEBCHAT_TIMEOUT, BACKSTOP_ROUNDS
"""

import argparse
import asyncio
import fcntl
import json
import os
import subprocess
import sys

import aiohttp

HELPOTRON_DIR = os.getenv("HELPOTRON_DIR", "/home/roni/Roni_Workspace/helpotron")
PLAN_FILE = os.getenv(
    "HELPOTRON_PLAN",
    "/home/roni/Roni_Workspace/audits_plans/helpotron_agentic_remediation_master_plan_8_21.json")
STATE_FILE = os.getenv(
    "HELPOTRON_STATE",
    "/home/roni/Roni_Workspace/audits_plans/helpotron_execution_state.json")
LOG_FILE = os.getenv("HELPOTRON_LOG",
                     "/home/roni/Roni_Workspace/audits_plans/helpotron_execution.log")
WEBCHAT_API_BASE = os.getenv("WEBCHAT_API_BASE", "http://127.0.0.1:8085/v1")
WEBCHAT_TIMEOUT = int(os.getenv("WEBCHAT_TIMEOUT", "900"))
BACKSTOP_ROUNDS = int(os.getenv("BACKSTOP_ROUNDS", "6"))
VENV_BIN = os.path.join(HELPOTRON_DIR, ".venv", "bin")
INBOX_FILE = os.getenv(
    "WEBCHAT_INBOX_FILE",
    "/home/roni/Roni_Workspace/audits_plans/claude_webchat_inbox.json")

# Flock fh must stay alive for the WHOLE run (2026-08-21 lesson: GC dropping
# the handle releases the flock and a second process double-writes).
_LOCK_FH = None


def log_exec(msg: str) -> None:
    line = f"[{__import__('datetime').datetime.now().isoformat(timespec='seconds')}] {msg}"
    with open(LOG_FILE, "a") as f:
        f.write(line + "\n")
    if any(k in msg for k in ("[HELPOTRON]", "[BATCH]", "[FATAL]", "[ESCALATION]")):
        print(line, flush=True)


def acquire_lock() -> None:
    global _LOCK_FH
    lock_path = STATE_FILE + ".lock"
    _LOCK_FH = open(lock_path, "a+")
    try:
        fcntl.flock(_LOCK_FH.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log_exec(f"[FATAL] Another helpotron executor holds {lock_path} — exiting.")
        sys.exit(3)


def load_state() -> dict:
    if os.path.exists(STATE_FILE):
        try:
            return json.load(open(STATE_FILE))
        except Exception:
            pass
    return {"completed_batches": [], "failed_batches": []}


def save_state(state: dict) -> None:
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE_FILE)


def notify_main(text: str) -> None:
    try:
        inbox = json.load(open(INBOX_FILE)) if os.path.exists(INBOX_FILE) else []
        if not isinstance(inbox, list):
            inbox = []
        inbox.append({"ts": __import__('datetime').datetime.now().isoformat(),
                      "from": "helpotron-batch", "text": text})
        with open(INBOX_FILE + ".tmp", "w") as f:
            json.dump(inbox, f, indent=2)
        os.replace(INBOX_FILE + ".tmp", INBOX_FILE)
    except Exception as e:
        log_exec(f"[NOTIFY] inbox write failed: {e}")


def _cmd_str(cmd) -> str:
    """Plan verification_commands may be plain strings OR dicts with a
    'command' key (08-21 dict format) — normalize to the shell string."""
    if isinstance(cmd, dict):
        return str(cmd.get("command") or cmd.get("cmd") or "")
    return str(cmd)


def run_verification(cmd: str, timeout: int = 180) -> tuple[bool, str]:
    """Run ONE verification command in the helpotron repo root with the venv
    python on PATH (commands are written as `python3 -c ...`)."""
    cmd = _cmd_str(cmd)
    env = dict(os.environ)
    env["PATH"] = VENV_BIN + ":" + env.get("PATH", "/usr/bin:/bin")
    try:
        p = subprocess.run(["bash", "-c", cmd], cwd=HELPOTRON_DIR, env=env,
                           capture_output=True, text=True, timeout=timeout)
        out = (p.stdout or "").strip() + ("\n" + p.stderr if p.stderr and p.stderr.strip() else "")
        return p.returncode == 0, out[:600]
    except subprocess.TimeoutExpired:
        return False, f"verification TIMED OUT after {timeout}s"
    except Exception as e:
        return False, str(e)[:200]


def batch_verification_passes(batch: dict) -> tuple[bool, str]:
    """Run ALL verification commands; return (all_passed, detail_string).
    Detail carries each command's output so failures feed REAL info into
    the feedback loop (was: output discarded -> 'details above' phantom)."""
    cmds = batch.get("verification_commands") or []
    if not cmds:
        return False, "no verification commands (phantom-pass guard)"
    details = []
    for i, cmd in enumerate(cmds, 1):
        cstr = _cmd_str(cmd)
        ok, out = run_verification(cmd)
        line = f"[verify#{i}] rc={'0' if ok else 'nonzero'}: {cstr[:120]}"
        if not ok:
            line += f"\n  OUTPUT: {out[:500]}"
        details.append(line)
        log_exec(f"      {line[:160]}")
        if not ok:
            return False, "\n".join(details)
    return True, "\n".join(details)


def shrink_guard(batch: dict) -> "str | None":
    obj = (batch.get("batch_title") or "").lower()
    if any(w in obj for w in ("remov", "delet", "clean", "strip", "truncat", "shrink")):
        return None
    for fa in batch.get("files_affected") or []:
        path = fa.get("path") if isinstance(fa, dict) else str(fa)
        tf = os.path.join(HELPOTRON_DIR, path)
        if not os.path.exists(tf):
            continue
        try:
            old_lines = subprocess.run(["git", "-C", HELPOTRON_DIR, "show", f"HEAD:{path}"],
                                       capture_output=True, text=True, timeout=15).stdout.count("\n")
        except Exception:
            continue
        if old_lines <= 10:
            continue
        new_lines = open(tf, "rb").read().count(b"\n")
        if new_lines < 0.4 * old_lines:
            return f"SUSPECT SHRINK {path}: {old_lines}->{new_lines} lines"
    return None


async def call_webchat(session: aiohttp.ClientSession, user_prompt: str,
                       system_prompt: str) -> str:
    """OpenAI-compatible call to the gemini webchat gateway (8085)."""
    url = f"{WEBCHAT_API_BASE.rstrip('/')}/chat/completions"
    payload = {
        "model": "anymodel",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "max_tokens": 4000,
        "autonomous": True,
    }
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
                    log_exec(f"    [WEBCHAT] empty content from gateway; retrying ({attempt+1})")
                else:
                    body = await resp.text()
                    log_exec(f"    [WEBCHAT] gateway HTTP {resp.status}: {body[:120]}")
        except asyncio.TimeoutError:
            log_exec(f"    [WEBCHAT] attempt {attempt+1} TIMED OUT after {WEBCHAT_TIMEOUT}s — "
                     f"gateway still generating (reply will land in thread; retrying).")
        except aiohttp.ServerDisconnectedError:
            log_exec(f"    [WEBCHAT] attempt {attempt+1} server disconnected — backing off "
                     f"{8 * (attempt + 1)}s.")
            await asyncio.sleep(8 * (attempt + 1))
        except Exception as e:
            log_exec(f"    [WEBCHAT] attempt {attempt+1} error: {str(e)[:150]}")
        await asyncio.sleep(4)
    return "ERROR: webchat unavailable after 3 attempts"


def _sys_prompt() -> str:
    return (
        "You are the HELPOTRON remediation expert — the PRIMARY executor of an agentic "
        f"remediation master plan. Your tools (run_bash, read_file, write_file, list_dir, "
        "edit_file) run with cwd=" + HELPOTRON_DIR + " (the git repo root — this is exactly "
        "where the pipeline verifies and commits your work). ALL relative paths are relative "
        "to THAT directory (e.g. `server/admin.py` means ./server/admin.py under the root).\n"
        "Work like a real engineer: investigate the actual code with your tools, then "
        "implement each remediation step at its ROOT CAUSE. Some plan snippets may not match "
        "the current code exactly (the plan was generated from an audit) — adapt the "
        "implementation to the real code while preserving the INTENT of the plan's after-"
        "snippet. The VERIFICATION COMMANDS listed in the batch are the acceptance criteria: "
        "they must ALL genuinely pass as written (or after adapting the implementation to "
        "make the intent pass). Run each verification command yourself with run_bash until "
        "it passes before you finish. If a verification command references an API that does "
        "not exist yet (e.g. `classify_assignment_type`), IMPLEMENT that API so the command "
        "passes — never delete or weaken a verification command, never fake a pass.\n"
        "Committing is handled by the pipeline — do NOT commit. The pipeline owns ALL git "
        "operations: NEVER run git checkout, git reset, git switch, git branch, git revert, "
        "git rebase, git clean, git stash, or git pull/fetch; NEVER move HEAD. The only git "
        "commands you may run are read-only: git status, git log -1, git diff. Work ONLY on "
        "files in the working tree at the current commit.\n"
        "Use the helpotron venv for python checks: `~/.venv/bin/python` is on your PATH as "
        "`python3` (the repo venv). Do not pip-install new packages unless the batch asks for "
        "it (the venv is frozen).\n"
        "Reply with a plain-text summary: per remediation step, what you changed and whether "
        "its verification passed."
    )


def _abs(path: str) -> str:
    """The gateway's tool runner works on ABSOLUTE paths (proven by the oculus
    executors). Render every plan path absolute."""
    p = str(path)
    return p if p.startswith("/") else os.path.join(HELPOTRON_DIR, p)


def _batch_spec(batch: dict) -> str:
    lines = [f"BATCH: {batch['batch_id']} — {batch['batch_title']}",
             f"Priority: {batch.get('priority')} | Findings: {batch.get('finding_references')}"]
    lines.append("\nFILES:")
    for fa in batch.get("files_affected") or []:
        if not isinstance(fa, dict):
            lines.append(f"  - {_abs(fa)}")
            continue
        lines.append(f"  - {_abs(fa.get('path'))} ({fa.get('operation')}, lines "
                     f"{fa.get('line_start')}-{fa.get('line_end')})")
        after = fa.get("after_snippet") or ""
        if after:
            lines.append("    TARGET AFTER-SNIPPET:\n" + after)
    lines.append("\nORDERED REMEDIATION GUIDE:")
    for i, g in enumerate(batch.get("atomic_remediation_guide") or [], 1):
        lines.append(f"  {i}. {g}")
    lines.append("\nVERIFICATION COMMANDS (must ALL pass — run them yourself):")
    for i, c in enumerate(batch.get("verification_commands") or [], 1):
        lines.append(f"  {i}. {c}")
    return "\n".join(lines)


async def _solve_batch(session: aiohttp.ClientSession, batch: dict) -> str:
    usr = ("Execute the remediation batch below COMPLETELY and IN ORDER: implement every "
           "file change at its root cause, then run each verification command with run_bash "
           "until they ALL genuinely pass. Do not finish while any verification command "
           "fails. When done, reply with a short summary: per step, what you changed and the "
           "verification result.\n\n"
           "VERIFICATION RULES: the verification commands are script files under the "
           "repo's .verify/ directory — run them EXACTLY as written (e.g. `python3 "
           ".verify/batch_XX_verify.py`) with run_bash. The executor runs these exact "
           "scripts locally, so a pass in your sandbox must come from the same checks. "
           "Never substitute different endpoints or write your own verify script; if a "
           "script fails, fix the CODE, never the script.\n\n" + _batch_spec(batch))
    return await call_webchat(session, usr, _sys_prompt())


async def _solve_batch_with_feedback(session: aiohttp.ClientSession, batch: dict,
                                     first_resp: str, first_err: str) -> tuple[bool, str]:
    """Feedback loop. `first_resp` is the batch-call answer already evaluated
    (and rolled back) by the caller — round 1 reuses it instead of re-sending
    the whole batch spec."""
    vok0, _ = batch_verification_passes(batch)
    if first_resp and not first_resp.startswith("ERROR:") and vok0:
        return True, first_resp
    err_detail = first_err or "verification failed after batch call"
    for r in range(1, BACKSTOP_ROUNDS + 1):
        backoff = min(600, 45 * (2 ** (r - 1)))
        if any(sig in err_detail.lower() for sig in ("rate_limit", "too frequent",
                                                     "unavailable", "server disconnected", "429")):
            log_exec(f"    [BATCH] rate-limit signature — backing off {backoff}s (round {r}).")
            await asyncio.sleep(backoff)
        log_exec(f"    [BATCH] feedback round {r} for {batch['batch_id']} — "
                 f"feeding verification failure back.")
        usr = (
            f"PREVIOUS ROUND FAILED — verification did not pass.\n"
            f"Verification failure detail:\n{err_detail[:2000]}\n\n"
            f"Investigate the ROOT CAUSE with your tools — it may be in the code OR in the "
            f"verification command itself (wrong API name, missing import, command written "
            f"for a different code shape). Adapt the implementation so the command's INTENT "
            f"passes. The verification commands are .verify/ script files — run them EXACTLY "
            f"as written with run_bash (`python3 .verify/batch_XX_verify.py`); never "
            f"substitute different endpoints or rewrite the scripts. Re-run every "
            f"verification command yourself until they all genuinely pass, then report "
            f"DONE.\n\n"
            f"The batch to fix:\n" + _batch_spec(batch)
        )
        msg2 = await call_webchat(session, usr, _sys_prompt())
        if msg2 and not msg2.startswith("ERROR:"):
            vok, vdet = batch_verification_passes(batch)
            if vok:
                return True, msg2
            err_detail = f"verification still failing after feedback round:\n{vdet}"
            log_exec(f"      round {r} still failing:\n{vdet[:400]}")
    return False, "verification never passed after all feedback rounds"


def _rollback(batch: dict) -> None:
    rp = batch.get("rollback_procedure") or {}
    cmds = rp.get("commands") if isinstance(rp, dict) else None
    files = [fa.get("path") if isinstance(fa, dict) else str(fa)
             for fa in batch.get("files_affected") or []]
    if cmds:
        for c in str(cmds).split("\n"):
            if c.strip():
                subprocess.run(["bash", "-c", c], cwd=HELPOTRON_DIR, capture_output=True,
                               text=True, timeout=120)
    if files:
        subprocess.run(["git", "-C", HELPOTRON_DIR, "checkout", "--"] + files,
                       capture_output=True, timeout=30)


def _commit_batch(batch: dict) -> tuple[bool, str]:
    bid = batch["batch_id"]
    title = batch.get("batch_title") or ""
    files = [fa.get("path") if isinstance(fa, dict) else str(fa)
             for fa in batch.get("files_affected") or []]
    # `git add -A` (NOT path-scoped): batches CREATE new files
    # (.github/workflows/ci.yml etc.) — path-scoped add would error on
    # paths that don't exist yet. The repo is dedicated to this plan, so
    # staging everything is safe.
    ok_add, _ = subprocess.run(["git", "-C", HELPOTRON_DIR, "add", "-A"],
                               capture_output=True, text=True, timeout=30).returncode == 0, ""
    if not ok_add:
        return False, "git add failed"
    msg = f"[{bid}] {title[:70]} (helpotron remediation)"
    p = subprocess.run(["git", "-C", HELPOTRON_DIR, "commit", "-m", msg],
                       capture_output=True, text=True, timeout=30)
    if p.returncode != 0:
        low = (p.stdout + p.stderr).lower()
        if any(w in low for w in ("nothing to commit", "nothing added", "changes not staged")):
            subprocess.run(["git", "-C", HELPOTRON_DIR, "commit", "--allow-empty", "-m",
                            f"[{bid}] {title[:60]} (verification passed, no diff)"],
                           capture_output=True, text=True, timeout=30)
        else:
            return False, (p.stdout + p.stderr)[:200]
    for _ in range(3):
        push = subprocess.run(["git", "-C", HELPOTRON_DIR, "push", "origin", "HEAD"],
                              capture_output=True, text=True, timeout=120)
        if push.returncode == 0:
            return True, ""
        asyncio.get_event_loop().run_until_complete(asyncio.sleep(2))
    return False, (push.stdout + push.stderr)[:200]


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not args.dry_run:
        acquire_lock()

    plan = json.load(open(PLAN_FILE))
    batches = plan["batches"]
    state = load_state()
    completed = set(state.get("completed_batches", []))
    failed = set(state.get("failed_batches", []))
    log_exec(f"[HELPOTRON] Batch executor starting — {len(batches)} batches "
             f"({len(completed)} done, {len(failed)} failed). Lane: {WEBCHAT_API_BASE}")

    if args.dry_run:
        for b in batches:
            if b["batch_id"] in completed:
                continue
            vok, vdet = batch_verification_passes(b)
            if vok:
                log_exec(f"[HELPOTRON] DRY-RUN: {b['batch_id']} passes verification NOW (free-skip).")
            else:
                log_exec(f"[HELPOTRON] DRY-RUN: {b['batch_id']} needs LLM work.")
        return

    async with aiohttp.ClientSession() as session:
        for batch in batches:
            bid = batch["batch_id"]
            if bid in completed:
                continue
            vok, vdet = batch_verification_passes(batch)
            if vok:
                state["completed_batches"].append(bid)
                save_state(state)
                log_exec(f"[BATCH] {bid} COMPLETE (free-skip, already verified).")
                continue

            log_exec(f"[BATCH] ONE gemini webchat call for {bid}: {batch.get('batch_title')}")
            resp = await _solve_batch(session, batch)
            if resp.startswith("ERROR:"):
                log_exec(f"[BATCH] {bid} webchat call failed ({resp[:100]}) — "
                         f"falling to feedback loop.")
                ok_w, msg_w = await _solve_batch_with_feedback(session, batch, None, resp)
            else:
                vok, vdet = batch_verification_passes(batch)
                if vok:
                    ok_w, msg_w = True, resp
                else:
                    log_exec(f"[BATCH] {bid} verification does not pass after batch call — "
                             f"rolling back + feedback loop.\n{vdet}")
                    _rollback(batch)
                    ok_w, msg_w = await _solve_batch_with_feedback(
                        session, batch, resp,
                        f"local verification commands failed after the batch call:\n{vdet}")

            if ok_w:
                sg = shrink_guard(batch)
                if sg:
                    log_exec(f"[BATCH] {sg}")
                    _rollback(batch)
                    ok_w = False
            if ok_w:
                ok_c, cerr = _commit_batch(batch)
                if not ok_c:
                    log_exec(f"[BATCH] {bid} commit failed: {cerr}")
                    ok_w = False

            if ok_w:
                state["completed_batches"].append(bid)
                save_state(state)
                log_exec(f"[BATCH] {bid} COMPLETE & CHECKPOINTED.")
            else:
                state["failed_batches"].append(bid)
                save_state(state)
                notify_main(f"[helpotron batch escalation] {bid} failed after feedback rounds. "
                            f"Main: please investigate. {msg_w[:300]}")
                log_exec(f"[BATCH] {bid} recorded failed (continue-on-failure).")

    # Final gate: the plan's master verification harness (run_all_batches.sh).
    script = (plan.get("master_execution_script") or {}).get("bash_content") or ""
    if script:
        log_exec("[HELPOTRON] Running master verification harness (all 10 batches)...")
        env = dict(os.environ)
        env["PATH"] = VENV_BIN + ":" + env.get("PATH", "/usr/bin:/bin")
        p = subprocess.run(["bash", "-c", script], cwd=HELPOTRON_DIR, env=env,
                           capture_output=True, text=True, timeout=600)
        tail = ((p.stdout or "") + "\n" + (p.stderr or ""))[-1500:]
        log_exec(f"[HELPOTRON] Master harness rc={p.returncode}:\n{tail}")
        notify_main(f"[helpotron batch] master harness rc={p.returncode}")

    state = load_state()
    log_exec(f"[HELPOTRON] Pass complete: {len(set(state.get('completed_batches', [])))}/10 "
             f"batches done, {len(set(state.get('failed_batches', [])))} failed.")


if __name__ == "__main__":
    asyncio.run(main())
