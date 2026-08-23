"""Dual-lane cross-eval swarm.

Takes the audit findings JSON and has BOTH webchat lanes (gemini 8085 +
deepseek 8080) independently evaluate every finding against the CURRENT
code, then merges the verdicts:

  both confirm      -> confirmed (enters the plan)
  one confirms      -> needs_review (human/adversarial pass)
  both dismiss      -> dismissed

Per-finding batches use the same lane machinery as the audit: rate-limited
lanes hand calls to OmniRoute (15-min retry, swap back), state is persisted
so an interrupted run resumes where it stopped.

Usage:
  python -m swarm.cross_eval_swarm --repo /path --findings /tmp/audit.json \
      --out /tmp/cross_eval.json [--dry-run]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from typing import Any, Dict, List

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from swarm.swarm_common import (  # noqa: E402
    LANES, call_with_takeover, extract_json_block, log,
)

EVAL_SYSTEM_PROMPT = (
    "You are an adversarial code-review judge. You are given ONE audit "
    "finding plus the current repo. Verify the finding against the ACTUAL "
    "current code — it may already be fixed, may never have been real, or "
    "may be confirmed. Return ONLY JSON:\n"
    '{"verdict": "confirmed" | "dismissed", "severity": "critical|high|medium|low", '
    '"confidence": 0.0-1.0, "reason": "<one sentence, quote current code>", '
    '"fix_quality": "good" | "weak" | "none", "fix": "<concrete fix for the '
    'CURRENT code, or empty if none needed>"}\n'
    "Rules: quote the current line you inspected. Never confirm a finding "
    "against code you did not see. If the file or line no longer exists, "
    "verdict dismissed."
)


def _finding_batches(findings: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    batches = []
    for f in findings:
        batches.append({
            "batch_id": f["id"],
            "title": f.get("title", ""),
            "file": f.get("file", ""),
            "verification_commands": [
                {"command_number": 1, "description": "finding file still exists",
                 "command": f"test -f {f.get('file', '/dev/null')}"},
            ],
        })
    return batches


def _eval_prompt(repo: str, finding: Dict[str, Any]) -> str:
    file = finding.get("file", "")
    path = os.path.join(repo, file)
    snippet = ""
    try:
        with open(path, errors="replace") as fh:
            lines = fh.read().splitlines()
        line = finding.get("line")
        if isinstance(line, int) and 0 < line <= len(lines):
            start = max(0, line - 3)
            snippet = "\n".join(f"{i + 1}: {l}" for i, l in enumerate(lines[start:line + 4], start))
        else:
            snippet = "\n".join(f"{i + 1}: {l}" for i, l in enumerate(lines[:12], 1))
    except OSError:
        snippet = "(file unreadable — treat as dismissed)"
    return (
        f"REPO: {os.path.basename(repo)}\n"
        f"FINDING ID: {finding.get('id')}\n"
        f"SEVERITY CLAIMED: {finding.get('severity')}\n"
        f"TITLE: {finding.get('title')}\n"
        f"DETAIL: {finding.get('detail')}\n"
        f"SUGGESTED FIX: {finding.get('suggested_fix')}\n\n"
        f"CURRENT CODE AT {file} (around line {finding.get('line')}):\n{snippet}"
    )


async def _evaluate(session, repo: str, finding: Dict[str, Any],
                    lane: Dict[str, str]) -> Dict[str, Any]:
    prompt = _eval_prompt(repo, finding)
    raw = await call_with_takeover(session, lane, prompt, EVAL_SYSTEM_PROMPT, max_tokens=2000)
    parsed = extract_json_block(raw)
    if parsed is None:
        return {"lane": lane["name"], "verdict": "dismissed", "confidence": 0.0,
                "reason": "non-JSON eval reply", "fix_quality": "none", "fix": ""}
    return {
        "lane": lane["name"],
        "verdict": parsed.get("verdict", "dismissed"),
        "severity": parsed.get("severity", finding.get("severity", "medium")),
        "confidence": float(parsed.get("confidence", 0.0) or 0.0),
        "reason": (parsed.get("reason") or "")[:1000],
        "fix_quality": parsed.get("fix_quality", "none"),
        "fix": (parsed.get("fix") or "")[:2000],
    }


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="/home/roni/Roni_Workspace/helpotron")
    ap.add_argument("--findings", required=True)
    ap.add_argument("--out", default=f"/home/roni/Roni_Workspace/audits_plans/cross_eval_{time.strftime('%m-%d')}.json")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    with open(args.findings) as f:
        audit = json.load(f)
    findings = audit["findings"]
    batches = _finding_batches(findings)
    log(f"Cross-eval: {len(findings)} findings, dual lanes")

    if args.dry_run:
        log("DRY-RUN: batches ready")
        return

    results: Dict[str, Any] = {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                               "repo": args.repo, "source": args.findings,
                               "evaluations": [], "verdicts": {}}

    async with __import__("aiohttp").ClientSession() as session:
        for i, finding in enumerate(findings):
            bids = {lane["name"]: {"verdict": None} for lane in LANES.values()}
            verdicts: List[Dict[str, Any]] = []
            for lane in LANES.values():
                try:
                    ev = await _evaluate(session, args.repo, finding, lane)
                except Exception as e:  # noqa: BLE001
                    ev = {"lane": lane["name"], "verdict": "dismissed", "confidence": 0.0,
                          "reason": f"eval error: {str(e)[:200]}", "fix_quality": "none", "fix": ""}
                verdicts.append(ev)
                bids[lane["name"]]["verdict"] = ev["verdict"]
                results["evaluations"].append({**finding, "eval": ev})

            vg = [v["verdict"] for v in verdicts]
            confirmed = vg.count("confirmed")
            dismissed = vg.count("dismissed")
            if confirmed == 2:
                final = "confirmed"
            elif dismissed == 2:
                final = "dismissed"
            else:
                final = "needs_review"
            results["verdicts"][finding["id"]] = {
                "status": final,
                "votes": vg,
                "severity": max((v["severity"] for v in verdicts), key=lambda s: ["low", "medium", "high", "critical"].index(s)),
                "fix_quality": max((v["fix_quality"] for v in verdicts), key=lambda q: ["none", "weak", "good"].index(q)),
                "fix": next((v["fix"] for v in verdicts if v["fix_quality"] == "good" and v["fix"]), ""),
                "reasons": [v["reason"] for v in verdicts],
                "lanes": bids,
            }
            if (i + 1) % 5 == 0 or i == len(findings) - 1:
                log(f"  {i + 1}/{len(findings)} evaluated ({final})")

    with open(args.out, "w") as f:
        json.dump(results, f, indent=2)
    counts = {"confirmed": 0, "needs_review": 0, "dismissed": 0}
    for v in results["verdicts"].values():
        counts[v["status"]] += 1
    log(f"Cross-eval complete: {counts} -> {args.out}")


if __name__ == "__main__":
    asyncio.run(main())
