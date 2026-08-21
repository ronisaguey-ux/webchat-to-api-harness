#!/usr/bin/env python3
"""run_batch_executor.py — BATCH MODE for oculus plan execution (2026-08-21, user order).

Why: the per-step executor makes ~1 webchat LLM round-trip per step, fully
sequential — that latency floor is why a 1500-step plan takes ~10h. Batch mode
sends up to BATCH_SIZE consecutive steps in ONE webchat call; the expert
implements them in order, verifying each before moving on.

Per-step semantics remain IDENTICAL to execute_master_oculus_plan.py:
  - import-resolution gate (phantom-API guard) before work
  - step_already_verified() free-skip (zero LLM for steps that already pass)
  - harness re-runs verification after the batch call
  - destructive-shrink guard on tracked files
  - git add + git commit per step (empty-diff marker for verification-only steps)
  - git push per step; atomic state checkpoint per step
  - a step failing mid-batch is rolled back, recorded, and re-attempted via the
    per-step webchat solver with failure feedback — never skipped.

Locking: same EXECUTION_STATE_FILE.lock flock as the main executor, held for
the whole run. The main executor exits FATAL on lock contention, so the two
can never run concurrently.

Usage:  python3 run_batch_executor.py [--batch-size N] [--dry-run]
"""

import argparse
import asyncio
import fcntl
import json
import os
import subprocess
import sys

import aiohttp

AUDITS_PLANS_DIR = os.getenv("AUDITS_PLANS_DIR", "/home/roni/Roni_Workspace/audits_plans")
# MASTER_PLAN_FILE must be set BEFORE the module import (it reads env at import).
os.environ.setdefault("MASTER_PLAN_FILE", f"{AUDITS_PLANS_DIR}/master_oculus_plan_8_14.md")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from execute_master_oculus_plan import (  # noqa: E402
    MASTER_PLAN_FILE,
    EXECUTION_STATE_FILE,
    OCULUS_DIR,
    PIPELINE_WORK_DIR,
    WEBCHAT_INBOX_FILE,
    WEBCHAT_ESCAPE_ATTEMPTS,
    parse_master_plan,
    load_execution_state,
    save_execution_state,
    step_already_verified,
    gate_import_resolution,
    run_isolated_shell_command,
    _git_add_paths,
    call_webchat,
    log_exec,
    solve_step_with_webchat,
    _exec_log_tail,
    _preserved_worktree_snippet,
    _restore_protected_files,
    execute_rollback,
    get_graphify,
    datetime,
)

BATCH_SIZE = int(os.getenv("BATCH_SIZE", "4"))
BACKSTOP_ROUNDS = max(6, WEBCHAT_ESCAPE_ATTEMPTS * 3)


def acquire_lock():
    lock_path = EXECUTION_STATE_FILE + ".lock"
    fh = open(lock_path, "a+")
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log_exec(f"[FATAL] Another executor holds {lock_path} — batch mode exits.")
        sys.exit(3)
    return fh


def _notify_main(text: str) -> None:
    """Write an escalation note to the webchat->main inbox (wakes main)."""
    try:
        inbox = json.load(open(WEBCHAT_INBOX_FILE)) if os.path.exists(WEBCHAT_INBOX_FILE) else []
        if not isinstance(inbox, list):
            inbox = []
        inbox.append({"ts": datetime.now().isoformat(), "from": "orch", "text": text})
        with open(WEBCHAT_INBOX_FILE + ".tmp", "w") as f:
            json.dump(inbox, f, indent=2)
        os.replace(WEBCHAT_INBOX_FILE + ".tmp", WEBCHAT_INBOX_FILE)
    except Exception as e:
        log_exec(f"[CALLS-MAIN] failed to write webchat inbox: {e}")


def _shrink_guard(step, target_files) -> "str | None":
    """Mirror the single-step solver's destructive-shrink guard."""
    obj = (step.get("objective") or "").lower()
    if any(w in obj for w in ("remove", "delete", "dedup", "extract", "split", "migrat",
                              "simplif", "shrink", "consolidat", "collaps", "truncat", "strip")):
        return None
    for tf in _git_add_paths(target_files or []):
        try:
            old_lines = subprocess.run(
                ["git", "-C", PIPELINE_WORK_DIR, "show", f"HEAD:{tf}"],
                capture_output=True, text=True, timeout=15).stdout.count("\n")
        except Exception:
            continue
        if old_lines <= 10:
            continue
        try:
            new_lines = open(os.path.join(PIPELINE_WORK_DIR, tf), "rb").read().count(b"\n")
        except Exception:
            continue
        if new_lines < 0.4 * old_lines:
            return f"SUSPECT SHRINK {tf}: {old_lines}->{new_lines} lines — wholesale replacement"
    return None


async def _commit_step(step) -> tuple[bool, str]:
    """git add + commit + push for one step (mirrors the single-step solver)."""
    step_idx = step["step_index"]
    total_steps = step["total_steps"]
    add_paths = _git_add_paths(step.get("target_files") or [])
    ok_add, add_out = run_isolated_shell_command(
        "git add -- " + " ".join(add_paths) if add_paths else "git status", timeout=15)
    if not ok_add:
        return False, f"git add failed: {add_out[:200]}"
    c_msg = f"[STEP {step_idx}/{total_steps}] (Webchat Expert) {step['objective'][:70]}"
    ok_c, c_out = run_isolated_shell_command(f'git commit -m "{c_msg}"', timeout=15)
    if not ok_c:
        low = c_out.lower()
        if any(w in low for w in ("nothing to commit", "working tree clean",
                                  "changes not staged", "nothing added to commit")):
            # verification-only step: passed but produced no diff — marker commit.
            run_isolated_shell_command(
                f'git commit --allow-empty -m "[STEP {step_idx}/{total_steps}] (Webchat Expert) '
                f'{step["objective"][:60]} (verification passed, no file changes)"', timeout=15)
        else:
            return False, f"git commit failed: {c_out[:200]}"
    for _ in range(3):
        ok_push, _ = run_isolated_shell_command("git push origin HEAD", timeout=120)
        if ok_push:
            break
        await asyncio.sleep(2)
    return True, ""


def _batch_sys_prompt() -> str:
    return (
        "You are the OCULUS webchat expert — the PRIMARY executor of pipeline plan steps "
        "(the OmniRoute LLM team is retired per the 2026-08-16 directive; every step in this "
        "message is yours to implement and verify). You have TOOLS: run_bash, read_file, "
        "write_file, list_dir, search_web, git_status, audit_status, telegram_send. "
        f"WORKING DIRECTORY: your tools run with cwd={PIPELINE_WORK_DIR} (the git repo root — "
        "this is exactly where the pipeline verifies and commits your work). ALL relative paths "
        "are relative to THAT directory. Follow each step's file paths verbatim: a path like "
        "`oculus/data_validation.py` means ./oculus/data_validation.py under the git root, "
        "`tests/test_*.py` means ./tests/ under the git root. Work like a real engineer, not a "
        "code-generator: use your tools to INVESTIGATE the actual failure and fix its ROOT "
        "CAUSE. The root cause may be in the step's code OR entirely outside it — a wrong "
        "python interpreter (system python3 often lacks the repo's deps while the project venv "
        "has them), a missing dependency, a broken/incorrect verification command, a wrong "
        "path. Diagnose from the failure output and fix whatever is actually wrong, then run "
        "each verification command with run_bash until they genuinely pass. If a verification "
        "failure is a benign diagnostic (missing stubs, 'no tests ran', import-not-found on "
        "optional deps, py_compile on non-python files), note it and move on.\n"
        "Committing is handled by the pipeline — do NOT commit. The pipeline also owns ALL git "
        "history/branch operations: NEVER run git checkout, git reset, git switch, git branch, "
        "git revert, git rebase, git clean, git stash, or git pull/fetch; NEVER move HEAD or "
        "change the checked-out branch/commit. The only git commands you may run are read-only: "
        "git status, git log -1, git diff. Work ONLY on files in the working tree at their "
        "current commit — the current checkout is always the correct base.\n"
        "STEP FIXING (08-19, user rule — plan steps are NOT sacred): if a step itself is "
        "flawed — wrong module paths, broken or impossible verification commands, target files "
        "that don't exist, an objective that cannot be achieved as written — FIX THE STEP "
        "instead of failing. End your reply with this JSON block:\n"
        '{"plan_edit": {"step_index": <the plan step number>, "old_text": "EXACT verbatim '
        'substring of the current step block you replace", "new_text": "your corrected step '
        'block"}}\n'
        "Guardrails: never change the '### STEP x/y:' header line; keep the TARGET_FILES, "
        "CODE_OPERATIONS, VERIFICATION and COMMIT_MESSAGE sections; VERIFICATION must keep at "
        "least ONE real command that genuinely tests the step (no echo/true/pass placeholders); "
        "fix the step to be CORRECTLY achievable, never easier. If all steps are fine as "
        "written, omit the block.\n"
        "Reply with a plain-text summary: per step, the root cause you found and the "
        "verification result, and the plan_edit JSON block if any step is flawed as written."
    )


async def _solve_batch(session, batch) -> str:
    lines = []
    for i, step in enumerate(batch, 1):
        ver = "\n".join(f"  {j + 1}. {c}" for j, c in enumerate(step.get("verification", [])))
        lines.append(
            f"STEP {i} OF {len(batch)} (plan step #{step['step_index']}/{step['total_steps']}): "
            f"{step['objective']}\nCategory: {step['category']} | Files: {step['target_files']}\n"
            f"VERIFICATION COMMANDS THAT MUST ALL PASS:\n{ver}"
        )
    usr_prompt = (
        "Execute the steps below IN ORDER, one at a time. For EACH step: implement it with "
        "your tools, then run its verification commands with run_bash until they genuinely "
        "pass BEFORE starting the next step. Do not move on from a step whose verification "
        "does not pass. If a step is flawed as written, fix the step (plan_edit block) and "
        "still complete it. When all steps are done, reply with a short plain-text summary "
        "reporting per step: what you changed and whether its verification passed.\n\n"
        + "\n\n".join(lines)
    )
    return await call_webchat(session, usr_prompt, _batch_sys_prompt())


async def _solve_step_with_feedback(session, step) -> tuple[bool, str]:
    """Per-step webchat fallback with failure feedback loop (mirrors the main
    executor's webchat escalation tier: rate-limit backoff + backstop)."""
    ctx = ("OCULUS execution log (tail — investigate prior failures, incl. "
           "environment/verification causes):\n" + _exec_log_tail(40))
    for r in range(1, BACKSTOP_ROUNDS + 1):
        _restore_protected_files(step.get("target_files") or [])
        ok, msg = await solve_step_with_webchat(session, step, get_graphify(), ctx)
        if ok:
            return True, msg
        low = (msg or "").lower()
        if any(sig in low for sig in ("rate_limit", "too frequent", "webchat unavailable",
                                      "server disconnected", "429")):
            backoff = min(600, 45 * (2 ** (r - 1)))
            log_exec(f"    [BATCH-fallback] rate-limit signature — backing off {backoff}s (round {r}).")
            await asyncio.sleep(backoff)
            continue
        log_exec(f"    [BATCH-fallback] per-step round {r} for Step {step['step_index']} failed "
                 f"({msg[:160]}). Feeding failure back...")
        ctx = (
            f"PREVIOUS WEBCHAT ROUND {r} FAILED — verification did not pass.\n"
            f"Verification failure detail:\n{msg[:2000]}\n\n"
            "Investigate the ROOT CAUSE with your tools — it may be in the step's code OR in "
            "the environment/verification setup. FIX the underlying cause, re-run the "
            "verification yourself, and report DONE only when the step's verification commands "
            "genuinely pass.\n\n"
            f"OCULUS execution log (for investigation):\n{_exec_log_tail(40)}"
        )
    return False, ctx


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch-size", type=int, default=BATCH_SIZE)
    ap.add_argument("--dry-run", action="store_true", help="Scan + report only (no LLM, no commits).")
    args = ap.parse_args()

    if not args.dry_run:
        acquire_lock()  # held for the whole run; main executor exits FATAL on contention
    log_exec(f"[BATCH] Batch mode starting (batch-size={args.batch_size}, dry-run={args.dry_run})")
    log_exec(f"[BATCH] Plan: {MASTER_PLAN_FILE}")

    steps = parse_master_plan(MASTER_PLAN_FILE)
    state = load_execution_state()
    completed = set(state.get("completed_steps", []))
    pending = [s for s in steps if s["step_index"] not in completed]
    log_exec(f"[BATCH] {len(completed)} completed, {len(pending)} pending")

    if args.dry_run:
        free = sum(1 for s in pending if step_already_verified(s))
        need_llm = len(pending) - free
        log_exec(f"[BATCH] DRY-RUN: {free} pending steps pass verification NOW (free-skip, zero LLM); "
                 f"{need_llm} need LLM work (~{(need_llm + args.batch_size - 1) // args.batch_size} "
                 f"webchat calls at batch-size={args.batch_size}).")
        return

    async with aiohttp.ClientSession() as session:
        i = 0
        while i < len(pending):
            step = pending[i]
            s_idx = step["step_index"]

            unresolved = gate_import_resolution(step)
            if unresolved:
                log_exec(f"[GATE] Step {s_idx} references unresolvable modules: {unresolved} — recording failed (phantom-API guard).")
                state["failed_steps"].append(s_idx)
                save_execution_state(state)
                _notify_main(f"[orch batch gate-skip] Step {s_idx} ({str(step.get('objective', ''))[:120]}) "
                             f"references unresolvable modules: {unresolved}. Main: please fix the plan/code references.")
                i += 1
                continue

            if step_already_verified(step):
                state["completed_steps"].append(s_idx)
                save_execution_state(state)
                log_exec(f"[BATCH] Step {s_idx}/{step['total_steps']} COMPLETE (free-skip, already verified).")
                i += 1
                continue

            # Build the batch: consecutive pending steps that need LLM work.
            batch = [step]
            j = i + 1
            while len(batch) < args.batch_size and j < len(pending):
                nxt = pending[j]
                if gate_import_resolution(nxt) or step_already_verified(nxt):
                    break
                batch.append(nxt)
                j += 1

            log_exec(f"[BATCH] ONE webchat call for steps {batch[0]['step_index']}..{batch[-1]['step_index']} "
                     f"({len(batch)} steps): " + "; ".join(f"#{b['step_index']} {b['objective'][:50]}" for b in batch))

            resp = await _solve_batch(session, batch)
            if not resp or resp.startswith("ERROR:"):
                log_exec(f"[BATCH] webchat call failed ({resp[:120]}) — falling back to per-step solver for "
                         f"step {batch[0]['step_index']}.")
                ok_w, msg_w = await _solve_step_with_feedback(session, batch[0])
                if ok_w:
                    state["completed_steps"].append(batch[0]["step_index"])
                    save_execution_state(state)
                    log_exec(f"[BATCH] Step {batch[0]['step_index']} COMPLETE via per-step fallback.")
                else:
                    state["failed_steps"].append(batch[0]["step_index"])
                    save_execution_state(state)
                    _notify_main(f"[orch batch escalation] Step {batch[0]['step_index']} failed after per-step "
                                 f"fallback. Main: please investigate. {msg_w[:400]}")
                    log_exec(f"[BATCH] Step {batch[0]['step_index']} recorded failed (continue-on-failure).")
                i += 1
                continue

            # Verify + commit each step of the batch, in order.
            failed_at = None
            for k, bstep in enumerate(batch):
                b_idx = bstep["step_index"]
                if not step_already_verified(bstep):
                    failed_at = k
                    log_exec(f"[BATCH] Step {b_idx} verification does not pass after batch call.")
                    break
                sg = _shrink_guard(bstep, bstep.get("target_files") or [])
                if sg:
                    failed_at = k
                    log_exec(f"[BATCH] {sg}")
                    break
                ok_commit, cerr = await _commit_step(bstep)
                if not ok_commit:
                    failed_at = k
                    log_exec(f"[BATCH] Step {b_idx} commit failed: {cerr[:200]}")
                    break
                state["completed_steps"].append(b_idx)
                save_execution_state(state)
                log_exec(f"[BATCH] Step {b_idx}/{bstep['total_steps']} COMPLETE & CHECKPOINTED.")

            if failed_at is None:
                i += len(batch)
                continue

            # Mid-batch failure: roll back THAT step, then per-step fallback for it.
            fstep = batch[failed_at]
            log_exec(f"[BATCH] Step {fstep['step_index']} failed mid-batch — rolling back and handing "
                     f"to the per-step webchat solver.")
            execute_rollback(fstep["rollback_command"], fstep.get("target_files") or [], hard=False)
            ok_w, msg_w = await _solve_step_with_feedback(session, fstep)
            if ok_w:
                state["completed_steps"].append(fstep["step_index"])
                save_execution_state(state)
                log_exec(f"[BATCH] Step {fstep['step_index']} COMPLETE via per-step fallback.")
            else:
                state["failed_steps"].append(fstep["step_index"])
                save_execution_state(state)
                _notify_main(f"[orch batch escalation] Step {fstep['step_index']} failed after per-step "
                             f"fallback. Main: please investigate. {msg_w[:400]}")
                log_exec(f"[BATCH] Step {fstep['step_index']} recorded failed (continue-on-failure).")
            i += failed_at + 1  # retry the remaining batch members on the next scan

    log_exec("[BATCH] Pass complete. Remaining pending (incl. failed): "
             f"{len([s for s in steps if s['step_index'] not in set(state.get('completed_steps', []))])}. "
             "The main executor will pick up leftover/failed steps when this lock is released.")


if __name__ == "__main__":
    asyncio.run(main())
