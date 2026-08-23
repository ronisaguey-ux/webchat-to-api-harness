"""Dual-lane audit swarm.

Fans audit dimensions out across the gemini (8085) and deepseek (8080)
webchat lanes in parallel. Each dimension is a batch: the lane audits the
current repo tree for that dimension and returns a structured findings JSON.
Rate-limited lanes hand their calls to OmniRoute (15-min retry, swap back).

Usage:
  python -m swarm.audit_swarm --repo /path --out /tmp/audit_findings.json [--dry-run]

Output schema (audit_findings_<date>.json):
  {
    "generated_at": ..., "repo": ..., "lanes_used": [...],
    "findings": [
      {"id": "AUDIT-<date>-<n>", "dimension": "...", "severity": "critical|high|medium|low",
       "title": "...", "detail": "...", "file": "relative/path",
       "line": <int|null>, "evidence": "...", "suggested_fix": "...",
       "lanes": {"gemini": "...", "deepseek": "..."}}
    ]
  }

Only findings whose `file` exists on disk at audit time are kept (the plan
must never reference ghost paths).
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
    LANES, call_with_takeover, extract_json_block, log, run_verification,
)

DIMENSIONS = [
    ("auth_security", "Authentication, authorization, IDOR, secrets in code, injection, CORS, rate limiting"),
    ("data_integrity", "Database models, migrations, cascade deletes, uniqueness, orphaned rows, race conditions"),
    ("cost_and_llm", "LLM API usage, cost tracking, model allowlist compliance, effort-tier routing, credit charging"),
    ("frontend_ux", "React component correctness, state management, dead UI paths, broken navigation, a11y gaps"),
    ("api_correctness", "Route handlers, status codes, error handling, request validation, response shapes"),
    ("background_jobs", "Async tasks, agent sessions, SSE streams, websockets, timeouts, resource leaks"),
    ("compliance", "Privacy policy, terms, GDPR/FERPA markers, data retention, PII handling"),
    ("test_coverage", "Test files, stale tests, tests that lie (vacuous passes), missing coverage of new surfaces"),
    ("code_quality", "Dead code, stub/placeholder patterns, TODO/FIXME markers, duplicated logic, style drift"),
]

SYSTEM_PROMPT = (
    "You are a ruthless senior security + engineering auditor. You audit a "
    "live codebase and return ONLY a JSON object — no prose before or after. "
    "Schema:\n"
    '{"findings": [{"severity": "critical|high|medium|low", '
    '"title": "<short>", "detail": "<specific evidence from the code, quote the '
    'exact line>", "file": "<repo-relative path>", "line": <int or null>, '
    '"suggested_fix": "<concrete fix>"}]}\n'
    "Rules: every finding must reference a real file that exists in the tree "
    "I give you. Never invent paths. Never report a file twice. Only report "
    "genuine defects — if the area is clean, return {\"findings\": []}."
)


def _file_inventory(repo: str) -> List[str]:
    """Skeletonized file inventory (path + first-line signature), never raw
    bodies — the lane gets a map, not megabytes."""
    inv = []
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in (".git", "node_modules", ".venv", "__pycache__", "dist", "build", ".next")]
        for f in sorted(files):
            if not f.endswith((".py", ".jsx", ".js", ".ts", ".tsx", ".css", ".html", ".json", ".md")):
                continue
            p = os.path.join(root, f)
            rel = os.path.relpath(p, repo)
            try:
                with open(p, errors="replace") as fh:
                    first = fh.read(400).replace("\n", " ")[:160]
            except OSError:
                continue
            try:
                size = os.path.getsize(p)
            except OSError:
                size = 0
            inv.append(f"{rel} [{size}b] :: {first}")
    return inv


def _build_prompt(repo: str, dim: str, scope: str, inventory: List[str]) -> str:
    head = (
        f"REPO: {os.path.basename(repo)}\n"
        f"DIMENSION: {dim}\n"
        f"FOCUS: {scope}\n\n"
        "FILE INVENTORY (path [bytes] :: first line):\n"
    )
    return head + "\n".join(inventory)


def _dimension_batches(repo: str, inventory: List[str]) -> List[Dict[str, Any]]:
    batches = []
    for i, (dim, scope) in enumerate(DIMENSIONS, 1):
        bid = f"AUDIT-{time.strftime('%m-%d')}-{i:02d}-{dim}"
        batches.append({
            "batch_id": bid,
            "dimension": dim,
            "title": f"Audit: {dim}",
            "scope": scope,
            "verification_commands": [
                {"command_number": 1, "description": "repo is readable",
                 "command": f"test -d {repo}"},
            ],
        })
    return batches


async def _solve(session, repo: str, inventory: List[str], lane: Dict[str, str],
                 out: Dict[str, Any]) -> None:
    async def solver(s, batch: Dict[str, Any]) -> str:
        prompt = _build_prompt(repo, batch["dimension"], batch["scope"], inventory)
        parsed = None
        for attempt in range(3):
            raw = await call_with_takeover(s, lane, prompt, SYSTEM_PROMPT, max_tokens=4000)
            parsed = extract_json_block(raw)
            if parsed is not None:
                break
            log(f"    [{lane['name']}] {batch['batch_id']} non-JSON reply "
                f"(attempt {attempt + 1}/3): {raw[:160]!r} — retrying with fresh thread")
        if parsed is None:
            log(f"    [{lane['name']}] {batch['batch_id']} FAILED: non-JSON after 3 attempts")
            return "ERROR: non-JSON audit reply after 3 attempts"
        findings = parsed.get("findings") or []
        kept = []
        for f in findings:
            path = (f.get("file") or "").strip()
            if not path:
                continue
            full = os.path.join(repo, path)
            if not os.path.exists(full):
                log(f"    drop ghost path {path} (does not exist)")
                continue
            kept.append({
                "id": f"AUDIT-{time.strftime('%m-%d')}-{batch['batch_id'].split('-')[-1].upper()}-{len(out['findings']) + len(kept) + 1:03d}",
                "dimension": batch["dimension"],
                "severity": f.get("severity", "medium"),
                "title": (f.get("title") or "")[:200],
                "detail": (f.get("detail") or "")[:4000],
                "file": path,
                "line": f.get("line"),
                "suggested_fix": (f.get("suggested_fix") or "")[:2000],
                "lanes": {lane["name"]: "reported"},
            })
        out["findings"].extend(kept)
        log(f"    [{lane['name']}] {batch['batch_id']}: {len(kept)} findings kept")
        return f"OK {len(kept)} findings"
    return solver


LOCK_FILE = "/tmp/audit_swarm.lock"


def _acquire_lock() -> None:
    """Singleton guard: refuse to start if another audit run is alive.
    Prevents concurrent runs hammering the same lanes (observed 08-23:
    a survivor from 05:20 + a 06:28 relaunch ran side-by-side)."""
    import errno
    try:
        fd = os.open(LOCK_FILE, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except OSError as e:
        if e.errno != errno.EEXIST:
            raise
        try:
            with open(LOCK_FILE) as f:
                pid = int(f.read().strip() or 0)
        except (OSError, ValueError):
            pid = 0
        if pid and os.path.exists(f"/proc/{pid}"):
            sys.exit(f"FATAL: another audit_swarm is running (pid {pid}) — aborting")
        os.unlink(LOCK_FILE)  # stale lock from a dead run
        fd = os.open(LOCK_FILE, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    os.write(fd, str(os.getpid()).encode())
    os.close(fd)


def _release_lock() -> None:
    try:
        with open(LOCK_FILE) as f:
            pid = int(f.read().strip() or 0)
        if pid == os.getpid():
            os.unlink(LOCK_FILE)
    except (OSError, ValueError):
        pass


async def main() -> None:
    _acquire_lock()
    try:
        await _run()
    finally:
        _release_lock()


async def _run() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="/home/roni/Roni_Workspace/helpotron")
    ap.add_argument("--out", default=f"/home/roni/Roni_Workspace/audits_plans/audit_findings_{time.strftime('%m-%d')}.json")
    ap.add_argument("--dims", default="", help="comma-separated dimension names to audit (subset re-run)")
    ap.add_argument("--lanes", default="gemini,deepseek",
                    help="comma-separated lanes to use (default both; single lane = all batches on it)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    inventory = _file_inventory(args.repo)
    log(f"Inventory: {len(inventory)} files in {args.repo}")
    batches = _dimension_batches(args.repo, inventory)
    if args.dims:
        wanted = {d.strip() for d in args.dims.split(",") if d.strip()}
        batches = [b for b in batches if b["dimension"] in wanted]
        log(f"Dimension subset: {len(batches)} batches ({sorted(wanted)})")
    lanes = [l.strip() for l in args.lanes.split(",") if l.strip() in LANES]
    if not lanes:
        sys.exit(f"FATAL: no valid lanes in {args.lanes!r} (have {list(LANES)})")
    out = {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "repo": args.repo,
           "lanes_used": ["gemini", "deepseek"], "findings": []}

    if args.dry_run:
        log(f"DRY-RUN: {len(batches)} audit batches ready")
        return

    # Workers over a shared queue: round-robin when dual-lane, all batches
    # on the single lane otherwise (deepseek-only is the reliable fallback
    # when the gemini tab cannot sustain large prompts)
    if len(lanes) == 1:
        results = await asyncio.gather(_worker(0, batches, args.repo, inventory,
                                               out, LANES[lanes[0]], out_path=args.out))
    else:
        results = await asyncio.gather(*[
            _worker(i % 2, batch_list := batches[i::2], args.repo, inventory,
                    out, LANES["gemini" if i % 2 == 0 else "deepseek"], out_path=args.out)
            for i in range(2)
        ])
    del results

    with open(args.out, "w") as f:
        json.dump(out, f, indent=2)
    log(f"Audit complete: {len(out['findings'])} findings -> {args.out}")


async def _worker(start_idx: int, batches: List[Dict[str, Any]], repo: str,
                  inventory: List[str], out: Dict[str, Any], lane: Dict[str, str],
                  out_path: str = "") -> None:
    async with __import__("aiohttp").ClientSession() as session:
        solver = await _solve(session, repo, inventory, lane, out)
        for batch in batches:
            try:
                result = await solver(session, batch)
                if isinstance(result, str) and result.startswith("ERROR:"):
                    log(f"[{lane['name']}] {batch['batch_id']} failed: {result}")
                if out_path:
                    # crash-resilience: persist findings after every batch so
                    # an interrupted run keeps everything completed so far
                    with open(out_path, "w") as f:
                        json.dump(out, f, indent=2)
            except Exception as e:  # noqa: BLE001
                log(f"[{lane['name']}] {batch['batch_id']} failed: {str(e)[:140]}")


if __name__ == "__main__":
    asyncio.run(main())
