"""Shared lane machinery for the dual-lane audit / cross-eval swarm.

- call_lane(): OpenAI-compatible webchat gateway call (fresh thread first,
  exactly like the batch executor — threads accumulate an in-tab error banner
  after long generations).
- call_with_takeover(): primary lane call; on a rate-limit signature the call
  is re-routed to OmniRoute and retried every 15 minutes until success; the
  primary lane is used again afterwards (swap back).
- run_batches(): the shared automatic batch loop used by the audit AND the
  cross-eval (and, through plan_generator, the plan itself): verification
  pass -> free-skip; else LLM work -> verify -> commit; feedback rounds with
  exponential backoff on rate-limit signatures.

Lanes are passed as {"name": ..., "base": ...} dicts.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import time
from typing import Any, Awaitable, Callable, Dict, List, Optional

import aiohttp

logger = logging.getLogger("helpotron.swarm")

LANES = {
    "gemini": {"name": "gemini", "base": os.getenv("GEMINI_WEBCHAT_BASE", "http://127.0.0.1:8085/v1")},
    "deepseek": {"name": "deepseek", "base": os.getenv("DEEPSEEK_WEBCHAT_BASE", "http://127.0.0.1:8080/v1")},
}

OMNIROUTE_BASE = os.getenv("OMNIROUTE_API_BASE", "http://localhost:20128/api/v1")
OMNIROUTE_KEY = os.getenv("OMNIROUTE_API_KEY", "omniroute")
OMNIROUTE_MODEL = os.getenv("OMNIROUTE_MODEL", "gpt-4o-mini")

LANE_TIMEOUT = int(os.getenv("SWARM_LANE_TIMEOUT", "600"))
TAKEOVER_RETRY_SECONDS = int(os.getenv("SWARM_TAKEOVER_RETRY", "900"))  # 15 min
MAX_FEEDBACK_ROUNDS = int(os.getenv("SWARM_FEEDBACK_ROUNDS", "3"))

RATE_LIMIT_SIGNATURES = (
    "rate_limit", "rate limit", "too frequent", "unavailable",
    "server disconnected", "429", "quota", "temporarily blocked",
)


def log(msg: str) -> None:
    ts = time.strftime("%Y-%m-%dT%H:%M:%S")
    line = f"[{ts}] [SWARM] {msg}"
    logger.info(line)
    print(line, flush=True)


def is_rate_limited(text: str) -> bool:
    t = text.lower()
    return any(sig in t for sig in RATE_LIMIT_SIGNATURES)


def run_verification(cmd: str, cwd: str, timeout: int = 180) -> tuple[bool, str]:
    """Run a verification command; rc==0 is a pass (same contract as the
    batch executor's verifier)."""
    try:
        r = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        if r.returncode == 0:
            return True, (r.stdout or r.stderr or "").strip()[:200]
        return False, (r.stderr or r.stdout or "").strip()[:200]
    except subprocess.TimeoutExpired:
        return False, f"verify timed out after {timeout}s"
    except Exception as e:  # noqa: BLE001
        return False, str(e)[:200]


def batch_verification_passes(batch: Dict[str, Any], cwd: str) -> tuple[bool, str]:
    for v in batch.get("verification_commands", []):
        cmd = v["command"]
        ok, detail = run_verification(cmd, cwd)
        if not ok:
            return False, f"[verify] FAIL: {cmd} -> {detail}"
    return True, "all verifies pass"


async def call_lane(session: aiohttp.ClientSession, lane: Dict[str, str],
                    user_prompt: str, system_prompt: str,
                    max_tokens: int = 4000) -> str:
    """Call one webchat gateway lane (OpenAI-compatible). Returns the reply
    text, or raises SwarmLaneError on persistent failure."""
    base = lane["base"].rstrip("/")
    try:
        async with session.post(base + "/newchat", json={},
                                headers={"Content-Type": "application/json"},
                                timeout=aiohttp.ClientTimeout(total=30)) as resp:
            log(f"    [{lane['name']}] fresh thread started (newchat HTTP {resp.status})")
    except Exception as e:  # noqa: BLE001
        log(f"    [{lane['name']}] newchat skipped ({str(e)[:80]})")
    payload = {
        "model": "anymodel",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "max_tokens": max_tokens,
        "autonomous": True,
    }
    last_err = ""
    for attempt in range(3):
        try:
            async with session.post(base + "/chat/completions", json=payload,
                                    headers={"Content-Type": "application/json"},
                                    timeout=aiohttp.ClientTimeout(total=LANE_TIMEOUT)) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    content = (data["choices"][0]["message"].get("content") or "").strip()
                    if content:
                        return content
                    last_err = "empty content"
                else:
                    body = await resp.text()
                    last_err = f"HTTP {resp.status}: {body[:160]}"
                    if resp.status == 429:
                        raise SwarmRateLimited(last_err)
        except asyncio.TimeoutError:
            last_err = f"timeout after {LANE_TIMEOUT}s"
        except SwarmRateLimited:
            raise
        except aiohttp.ServerDisconnectedError:
            last_err = "server disconnected"
            await asyncio.sleep(8 * (attempt + 1))
        except Exception as e:  # noqa: BLE001
            last_err = str(e)[:160]
        await asyncio.sleep(4)
    raise SwarmLaneError(f"lane {lane['name']} unavailable after 3 attempts: {last_err}")


async def call_omniroute(session: aiohttp.ClientSession, user_prompt: str,
                         system_prompt: str) -> str:
    """Call the OmniRoute fallback gateway. Raises SwarmLaneError on failure."""
    url = f"{OMNIROUTE_BASE}/chat/completions"
    payload = {
        "model": OMNIROUTE_MODEL,
        "stream": False,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }
    headers = {"Authorization": f"Bearer {OMNIROUTE_KEY}", "Content-Type": "application/json"}
    try:
        async with session.post(url, json=payload, headers=headers,
                                timeout=aiohttp.ClientTimeout(total=LANE_TIMEOUT)) as resp:
            if resp.status == 200:
                data = await resp.json()
                return data["choices"][0]["message"]["content"]
            body = await resp.text()
            raise SwarmLaneError(f"omniroute HTTP {resp.status}: {body[:160]}")
    except asyncio.TimeoutError:
        raise SwarmLaneError("omniroute timeout") from None
    except SwarmLaneError:
        raise
    except Exception as e:  # noqa: BLE001
        raise SwarmLaneError(f"omniroute error: {str(e)[:160]}") from None


async def call_with_takeover(session: aiohttp.ClientSession, lane: Dict[str, str],
                             user_prompt: str, system_prompt: str,
                             max_tokens: int = 4000) -> str:
    """Primary-lane call with OmniRoute takeover.

    Rate-limited (or failed) -> OmniRoute takes over, retried every
    SWARM_TAKEOVER_RETRY seconds until success. After a success the primary
    lane is used again on the next call (swap back)."""
    try:
        return await call_lane(session, lane, user_prompt, system_prompt, max_tokens)
    except SwarmRateLimited:
        log(f"    [{lane['name']}] RATE-LIMITED -> OmniRoute takeover (retry every "
            f"{TAKEOVER_RETRY_SECONDS}s until success)")
        return await _omniroute_with_retry(session, user_prompt, system_prompt, max_tokens)
    except SwarmLaneError as e:
        log(f"    [{lane['name']}] lane failure ({str(e)[:100]}) -> OmniRoute takeover")
        return await _omniroute_with_retry(session, user_prompt, system_prompt, max_tokens)


async def _omniroute_with_retry(session: aiohttp.ClientSession, user_prompt: str,
                                system_prompt: str, max_tokens: int) -> str:
    while True:
        try:
            return await call_omniroute(session, user_prompt, system_prompt)
        except SwarmLaneError as e:
            log(f"    [omniroute] not ready ({str(e)[:100]}) — retrying in "
                f"{TAKEOVER_RETRY_SECONDS}s")
            await asyncio.sleep(TAKEOVER_RETRY_SECONDS)


async def run_batches(
    batches: List[Dict[str, Any]],
    cwd: str,
    solve: Callable[[aiohttp.ClientSession, Dict[str, Any]], Awaitable[str]],
    state_path: str,
    dry_run: bool = False,
    lane: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """The shared automatic batch loop (audit, cross-eval and plan-gen all
    use it). Batches with passing verifies free-skip; failures get feedback
    rounds with exponential backoff, then are recorded failed."""
    state = _load_state(state_path)
    completed = set(state.get("completed_batches", []))
    failed = set(state.get("failed_batches", []))
    log(f"Batch loop starting — {len(batches)} batches "
        f"({len(completed)} done, {len(failed)} failed)"
        + (f", lane: {lane['name']}" if lane else ""))

    async with aiohttp.ClientSession() as session:
        for batch in batches:
            bid = batch["batch_id"]
            if bid in completed:
                log(f"[BATCH] {bid} already complete (skip).")
                continue
            vok, vdet = batch_verification_passes(batch, cwd)
            if vok:
                completed.add(bid)
                failed.discard(bid)
                state["completed_batches"] = sorted(completed)
                state["failed_batches"] = sorted(failed)
                _save_state(state_path, state)
                log(f"[BATCH] {bid} COMPLETE (free-skip, already verified).")
                continue
            if dry_run:
                log(f"[BATCH] DRY-RUN: {bid} needs LLM work.")
                continue
            ok = False
            for round_idx in range(MAX_FEEDBACK_ROUNDS):
                backoff = min(600, 45 * (2 ** round_idx))
                try:
                    result = await solve(session, batch)
                except SwarmRateLimited:
                    # solve() itself routes through call_with_takeover, so a
                    # rate limit here means even OmniRoute is unavailable —
                    # back off and retry the round.
                    log(f"[BATCH] {bid} rate-limited — backoff {backoff}s (round {round_idx + 1}).")
                    await asyncio.sleep(backoff)
                    continue
                except Exception as e:  # noqa: BLE001
                    log(f"[BATCH] {bid} solve error: {str(e)[:140]} — backoff {backoff}s")
                    await asyncio.sleep(backoff)
                    continue
                if result.startswith("ERROR:"):
                    log(f"[BATCH] {bid} solver returned error — round {round_idx + 1}")
                    await asyncio.sleep(backoff)
                    continue
                vok, vdet = batch_verification_passes(batch, cwd)
                if vok:
                    ok = True
                    break
                log(f"[BATCH] {bid} verify failed after round {round_idx + 1}: {vdet[:140]}")
                await asyncio.sleep(backoff)
            if ok:
                completed.add(bid)
                failed.discard(bid)
                log(f"[BATCH] {bid} COMPLETE.")
            else:
                failed.add(bid)
                log(f"[BATCH] {bid} recorded failed (continue-on-failure).")
            state["completed_batches"] = sorted(completed)
            state["failed_batches"] = sorted(failed)
            _save_state(state_path, state)
    state["all_batches_complete"] = len(completed) == len(batches)
    _save_state(state_path, state)
    log(f"Batch loop done — {len(completed)}/{len(batches)} completed.")
    return state


def _load_state(path: str) -> Dict[str, Any]:
    try:
        with open(path) as f:
            st = json.load(f)
        st.setdefault("completed_batches", [])
        st.setdefault("failed_batches", [])
        return st
    except (OSError, json.JSONDecodeError):
        return {"completed_batches": [], "failed_batches": []}


def _save_state(path: str, state: Dict[str, Any]) -> None:
    with open(path, "w") as f:
        json.dump(state, f, indent=2)


def extract_json_block(text: str) -> Optional[Dict[str, Any]]:
    """Resilient JSON extraction: ```json fence -> first {...} block."""
    candidates = []
    for fence in ["```json", "```"]:
        if fence in text:
            for chunk in text.split(fence)[1:]:
                chunk = chunk.split("```")[0].strip()
                if chunk.startswith("{"):
                    candidates.append(chunk)
                    break
            if candidates:
                break
    if not candidates:
        start, end = text.find("{"), text.rfind("}")
        if start != -1 and end > start:
            candidates.append(text[start:end + 1])
    for cand in candidates:
        try:
            return json.loads(cand)
        except json.JSONDecodeError:
            continue
    return None


class SwarmLaneError(Exception):
    pass


class SwarmRateLimited(SwarmLaneError):
    pass
