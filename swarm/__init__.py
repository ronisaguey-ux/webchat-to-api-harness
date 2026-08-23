"""Dual-lane (gemini + deepseek webchat) audit & cross-eval swarm.

Lanes: gemini  -> http://127.0.0.1:8085/v1
       deepseek -> http://127.0.0.1:8080/v1

Every lane call carries OmniRoute takeover: on a rate-limit signature the call
is re-routed to OmniRoute (http://localhost:20128/api/v1), retried every 15
minutes until it succeeds, then the primary lane is used again (swap back).

Pipeline: audit_swarm.py (findings) -> cross_eval_swarm.py (consensus) ->
plan_generator.py (massive structured JSON remediation plan with a
ghost-step guard: every file path must exist and every verification command
must pass against the CURRENT tree at generation time).
"""
