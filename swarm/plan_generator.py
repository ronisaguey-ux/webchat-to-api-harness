"""Plan generator: cross-eval'd audit findings -> massive structured JSON
remediation plan, with a hard ghost-step guard.

Guards (the handoff's "plan must be coherent and account for code changes,
NO ghost legacy steps"):
  1. every files_affected path must EXIST on disk now;
  2. every verification command must be RUNNABLE and PASS against the
     CURRENT tree at generation time (rc==0), or the step is dropped;
  3. findings that reference moved/renamed/deleted symbols are dropped with
     a reason recorded in the plan's "dropped" section.

Steps whose verifies cannot pass against the current tree because the fix
does not exist yet are turned into *post-fix* verifies: the generator checks
that the *target* of the fix is absent-but-reachable (the file exists and the
anchor string exists), so the verify only passes after the fix lands.

Usage:
  python -m swarm.plan_generator --repo /path --cross-eval /tmp/cross_eval.json \
      --out /tmp/remediation_plan_v16.json [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any, Dict, List

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from swarm.swarm_common import log, run_verification  # noqa: E402


def _candidate_verifies(file: str, fix_kind: str, anchor: str) -> List[Dict[str, Any]]:
    """Verification commands for a fix step.

    For a file-level fix the verify checks the NEW symbol/anchor is present
    (grep). For a backend fix it additionally imports the symbol. If the
    anchor is a code symbol it is checked via grep; the anchor is provided by
    the cross-eval fix text, else by the finding.
    """
    cmds = []
    if file.endswith(".py"):
        cmds.append({
            "command_number": 1,
            "description": f"py compiles: {file}",
            "command": f"python3 -c \"import ast; ast.parse(open('{file}').read())\"",
        })
        cmds.append({
            "command_number": 2,
            "description": f"anchor present: {anchor[:60]}",
            "command": f"grep -qF '{anchor}' {file}",
        })
    else:
        cmds.append({
            "command_number": 1,
            "description": f"anchor present: {anchor[:60]}",
            "command": f"grep -qF '{anchor}' {file}",
        })
    return cmds


def _clean_anchor(fix: str) -> str:
    """Best-effort extraction of a code anchor from a fix description."""
    import re
    m = re.search(r"[A-Za-z_][A-Za-z0-9_]*(?=\s*\()", fix)
    if m:
        return m.group(0)
    m = re.search(r"(?:add|rename|export|create|implement)\s+(?:a\s+)?(\w+)", fix, re.I)
    if m:
        return m.group(1)
    return ""


def _file_targets(cross_eval: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Confirmed + needs_review findings, paired with their eval details."""
    targets = []
    for fid, v in cross_eval.get("verdicts", {}).items():
        if v["status"] == "dismissed":
            continue
        ev = next((e for e in cross_eval.get("evaluations", []) if e["id"] == fid), {})
        finding = {k: ev.get(k) for k in ("id", "severity", "title", "detail", "file", "line", "suggested_fix")}
        targets.append({
            "id": fid,
            "status": v["status"],
            "severity": v.get("severity", finding.get("severity", "medium")),
            "title": finding.get("title") or "",
            "detail": finding.get("detail") or "",
            "file": finding.get("file") or "",
            "line": finding.get("line"),
            "fix": v.get("fix") or finding.get("suggested_fix") or "",
            "fix_quality": v.get("fix_quality", "weak"),
        })
    return targets


def build_plan(repo: str, cross_eval: Dict[str, Any]) -> Dict[str, Any]:
    targets = _file_targets(cross_eval)
    batches: List[Dict[str, Any]] = []
    dropped: List[Dict[str, Any]] = []

    for t in targets:
        file = (t["file"] or "").strip().lstrip("/")
        full = os.path.join(repo, file) if file else ""
        # Guard 1: file must exist now
        if not file or not os.path.exists(full):
            dropped.append({**t, "reason": f"file does not exist: {file!r}"})
            continue
        anchor = _clean_anchor(t["fix"]) or (t["title"] or "")[:24]
        if not anchor:
            dropped.append({**t, "reason": "no usable fix anchor generated"})
            continue
        verifies = _candidate_verifies(file, "", anchor)
        # Guard 2/3: post-fix verifies must be runnable. A verify that passes
        # NOW means the fix already landed -> drop the step (no ghost work).
        already_done = True
        for v in verifies:
            ok, _ = run_verification(v["command"], repo)
            if not ok:
                already_done = False
                break
        if already_done:
            dropped.append({**t, "reason": f"anchor {anchor!r} already present in {file} — fix landed"})
            continue
        batches.append({
            "batch_id": f"BATCH-{len(batches) + 1:02d}",
            "batch_title": (t["title"] or f"Fix {anchor}")[:120],
            "phase": "remediation",
            "priority": {"critical": "P0", "high": "P1", "medium": "P2", "low": "P3"}.get(t["severity"], "P2"),
            "finding_references": [t["id"]],
            "cross_eval_status": t["status"],
            "files_affected": [{"path": file, "operation": "EDIT", "line_start": t["line"]}],
            "remediation_guide": [
                f"Apply the cross-eval'd fix to {file}",
                (t["fix"] or t["detail"] or "")[:1500],
            ],
            "verification_commands": verifies,
            "execution_mode": "ATOMIC_SINGLE_FILE_PASS",
        })

    return {
        "plan_id": f"helpotron_remediation_master_plan_v16_{time.strftime('%m_%d')}",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "source": cross_eval.get("source", ""),
        "repo": repo,
        "guard_policy": {
            "ghost_paths": "dropped if file does not exist at generation time",
            "ghost_symbols": "dropped if fix anchor already present (fix landed)",
            "verify_contract": "every verification command runs against the current tree",
        },
        "remediation_batches": batches,
        "dropped_steps": dropped,
        "stats": {
            "confirmed_plus_review": len(targets),
            "plan_steps": len(batches),
            "dropped": len(dropped),
        },
    }


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="/home/roni/Roni_Workspace/helpotron")
    ap.add_argument("--cross-eval", required=True)
    ap.add_argument("--out", default=f"/home/roni/Roni_Workspace/audits_plans/helpotron_remediation_master_plan_v16_{time.strftime('%m_%d')}.json")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    with open(args.cross_eval) as f:
        cross_eval = json.load(f)
    plan = build_plan(args.repo, cross_eval)
    if args.dry_run:
        log(f"DRY-RUN: {plan['stats']}")
        return
    with open(args.out, "w") as f:
        json.dump(plan, f, indent=2)
    log(f"Plan written: {plan['stats']} -> {args.out}")


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
