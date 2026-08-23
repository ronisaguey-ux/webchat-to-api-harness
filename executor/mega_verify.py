#!/usr/bin/env python3
"""mega_verify.py — one-shot verification sweep over ALL pending plan steps.

Reuses the executor's OWN step_already_verified() (the free-skip check), so
pass/fail semantics are bit-identical to what run_batch_executor.py would do
per-step — but without the executor loop, batch boundaries, or webchat calls.
Steps whose work is already in the tree get marked complete in one pass, and
the executor can resume at the REAL frontier instead of re-walking 1000+ steps.

Usage:
  python mega_verify.py --dry-run          # verify everything, report only
  python mega_verify.py --apply            # verify + persist passes to state
  python mega_verify.py --apply --from 946 --to 1100   # range-limited sweep

Run with the batch executor STOPPED (it owns the state file).
"""
import argparse
import os
import sys
import time

sys.path.insert(0, "/home/roni/Roni_Workspace/webchat-api/executor")

# PIN the live plan BEFORE import: the module's own default is a stale
# master_oculus_plan_8_3.md (560 steps); the orchestrator overrides it via env
# for the executor, and a standalone invocation must do the same or it would
# verify the wrong plan (08-21: mega-verify parsed 560 steps against a 1566-step
# plan state — zero pending).
_DEFAULT_PLAN = "/home/roni/Roni_Workspace/audits_plans/master_oculus_plan_8_14.md"
os.environ.setdefault("MASTER_PLAN_FILE", _DEFAULT_PLAN)

from execute_master_oculus_plan import (  # noqa: E402
    MASTER_PLAN_FILE,
    parse_master_plan,
    load_execution_state,
    save_execution_state,
    step_already_verified,
    log_exec,
)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="persist passing steps to the state file")
    ap.add_argument("--from", dest="lo", type=int, default=None)
    ap.add_argument("--to", dest="hi", type=int, default=None)
    args = ap.parse_args()

    log_exec(f"[MEGA-VERIFY] plan={MASTER_PLAN_FILE} apply={args.apply}")
    steps = parse_master_plan(MASTER_PLAN_FILE)
    state = load_execution_state()
    done = set(int(x) for x in state.get("completed_steps", []))
    failed = set(int(x) for x in state.get("failed_steps", []))

    pending = []
    for s in steps:
        idx = int(s["step_index"])
        if idx in done or idx in failed:
            continue
        if args.lo is not None and idx < args.lo:
            continue
        if args.hi is not None and idx > args.hi:
            continue
        pending.append(s)

    log_exec(f"[MEGA-VERIFY] {len(done)} done / {len(failed)} failed / {len(pending)} to verify")

    passed, need_work, t0 = [], [], time.time()
    for n, s in enumerate(pending, 1):
        idx = int(s["step_index"])
        ok = step_already_verified(s)
        if ok:
            passed.append(idx)
        else:
            need_work.append(idx)
        if n % 25 == 0:
            log_exec(f"[MEGA-VERIFY] {n}/{len(pending)} checked ({len(passed)} pass so far) "
                     f"{time.time()-t0:.0f}s elapsed")
            if args.apply:
                state["completed_steps"] = sorted(done | set(passed))
                save_execution_state(state)

    if args.apply:
        state["completed_steps"] = sorted(done | set(passed))
        save_execution_state(state)

    dt = time.time() - t0
    log_exec(f"[MEGA-VERIFY] DONE {len(passed)} pass / {len(need_work)} need work in {dt:.0f}s")
    if passed:
        log_exec(f"[MEGA-VERIFY] passed up to step {max(passed)} (skippable)")
    if need_work:
        log_exec(f"[MEGA-VERIFY] REAL FRONTIER begins at step {need_work[0]} "
                 f"(first {min(25, len(need_work))} of {len(need_work)} needing work: "
                 f"{need_work[:25]})")
    print(f"passed={len(passed)} need_work={len(need_work)} "
          f"frontier_at={need_work[0] if need_work else 'NONE'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
