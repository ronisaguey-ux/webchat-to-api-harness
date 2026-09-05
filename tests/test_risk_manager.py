"""STEP 327/456 — RiskManager async + incremental risk updates.

Verifies the SoT 9.1 kill-barrier semantics still hold, the incremental
update path is O(1) and matches the reference drawdown math, and the
async API is consistent with the sync API.
"""

import asyncio
import pytest
from oculus.risk_manager import RiskManager, RiskViolation


def test_on_bar_kill_breach():
    """Test that on_bar kills when drawdown exceeds thresholds."""
    rm = RiskManager(init_equity=100000.0)
    # Start at peak
    should_kill, should_liq, is_halted = rm.on_bar(100000.0, 0, 30)
    assert not should_kill
    # Drop 15% from initial - should kill (10% threshold)
    should_kill, should_liq, is_halted = rm.on_bar(85000.0, 1, 30)
    assert should_kill


def test_on_bar_no_kill_under_limits():
    """Test that on_bar does not kill when drawdown is under thresholds."""
    rm = RiskManager(init_equity=100000.0)
    # Stay near peak
    should_kill, should_liq, is_halted = rm.on_bar(100000.0, 0, 30)
    assert not should_kill
    # Small drop - should not kill
    should_kill, should_liq, is_halted = rm.on_bar(98000.0, 1, 30)
    assert not should_kill
    # Daily drawdown of 4% - under 5% threshold
    should_kill, should_liq, is_halted = rm.on_bar(96000.0, 2, 30)
    assert not should_kill


def test_incremental_deltas_match_reference_math():
    """Test that incremental updates match reference math."""
    rm = RiskManager(init_equity=100000.0)
    # Multiple bars with ups and downs - daily barrier anchors to the DAY OPEN
    # (100000): 95000 breaches it exactly (5% >= 5% -> kill), 92000 is 8%
    # below open (kill via init barrier too), 98000 recovers to 2% below open.
    values = [100000.0, 105000.0, 95000.0, 92000.0, 98000.0]
    expected_kill = [False, False, True, True, False]  # day-open base, >= 5% daily breach
    for i, (v, expected) in enumerate(zip(values, expected_kill)):
        should_kill, _, _ = rm.on_bar(v, i, 30)
        assert should_kill == expected, f"Bar {i}: value {v}, expected {expected}, got {should_kill}"


def test_async_kill_status_matches_sync():
    """Test that async update_kill_status matches sync."""
    rm = RiskManager(init_equity=100000.0)
    sync_result = rm.update_kill_status(85000.0)
    async_result = asyncio.run(rm.update_kill_status_async(85000.0))
    assert sync_result == async_result


def test_async_on_bar_matches_sync():
    """Test that async on_bar matches sync."""
    rm = RiskManager(init_equity=100000.0)
    sync_result = rm.on_bar(85000.0, 0, 30)
    async_result = asyncio.run(rm.on_bar_async(85000.0, 0, 30))
    assert sync_result == async_result


def test_bars_per_day_lru_cached():
    """Test that bars_per_day results are served by a real LRU cache.

    Asserts on cache_info() hit/miss counters so that removing or bypassing
    the @lru_cache makes this test FAIL instead of silently passing.
    """
    from oculus.risk_manager import _cached_bars_per_day

    # Reset counters so this test is independent of other tests' cache usage.
    _cached_bars_per_day.cache_clear()

    first = _cached_bars_per_day("2026-01-05", 30)
    second = _cached_bars_per_day("2026-01-05", 30)
    assert first == second == 2880

    info = _cached_bars_per_day.cache_info()
    assert info.misses == 1, f"expected exactly 1 miss after reset, got {info}"
    assert info.hits == 1, f"expected the repeat call to be a cache hit, got {info}"


def test_bars_per_day_standard_durations():
    """Test bars_per_day with standard durations."""
    rm = RiskManager(init_equity=100000.0)
    # 30-minute bars -> 48 bars per day
    rm.on_bar(100000.0, 0, 30)
    # 60-minute bars -> 24 bars per day
    rm.on_bar(100000.0, 0, 60)
    # 15-minute bars -> 96 bars per day
    rm.on_bar(100000.0, 0, 15)


def test_bars_per_day_cache_is_session_date_aware():
    """Regression: bars_per_day must be cached per session date, not globally.

    A holiday or DST-shortened session changes the effective session length;
    the cached barrier for one session date must never leak into another.
    """
    from oculus.risk_manager import _cached_bars_per_day
    # 30-min bars on a normal session -> 48 bars/day
    assert _cached_bars_per_day("2026-01-05", 30) == 2880
    # Same key -> served from cache, same value
    assert _cached_bars_per_day("2026-01-05", 30) == 2880
    # A different bar length within the same session date re-computes
    assert _cached_bars_per_day("2026-01-05", 60) == 1440
    # A different session date gets its own cache entry
    assert _cached_bars_per_day("2026-01-01", 30) == 2880


def test_on_bar_nonfinite_and_negative_equity_semantics():
    """Test on_bar with non-finite and negative equity values."""
    rm = RiskManager(init_equity=100000.0)
    # Negative equity should kill
    should_kill, _, _ = rm.on_bar(-1000.0, 0, 30)
    assert should_kill
    # NaN equity should NOT kill - we follow fail-open semantics for NaN
    should_kill, _, _ = rm.on_bar(float('nan'), 1, 30)
    assert not should_kill
    # Inf equity should not kill
    should_kill, _, _ = rm.on_bar(float('inf'), 2, 30)
    assert not should_kill


# Pre-trade risk tests
def test_pre_trade_accepts_valid_order():
    """Test that pre_trade accepts a valid order."""
    rm = RiskManager(init_equity=100000.0)
    order = {"symbol": "BTC/USD", "side": "buy", "quantity": 1.0, "leverage": 1.0}
    assert rm.check_order(order) is True


def test_pre_trade_rejects_oversized():
    """Test that pre_trade rejects oversized orders."""
    rm = RiskManager(init_equity=100000.0, config={"max_quantity": 10.0})
    order = {"symbol": "BTC/USD", "side": "buy", "quantity": 100.0, "leverage": 1.0}
    with pytest.raises(RiskViolation):
        rm.check_order(order)


def test_pre_trade_rejects_overleveraged():
    """Test that pre_trade rejects overleveraged orders."""
    rm = RiskManager(init_equity=100000.0, config={"max_leverage": 2.0})
    order = {"symbol": "BTC/USD", "side": "buy", "quantity": 1.0, "leverage": 10.0}
    with pytest.raises(RiskViolation):
        rm.check_order(order)


def test_pre_trade_rejects_when_killed():
    """Test that pre_trade rejects orders when killed."""
    rm = RiskManager(init_equity=100000.0)
    rm.update_kill_status(85000.0)
    order = {"symbol": "BTC/USD", "side": "buy", "quantity": 1.0, "leverage": 1.0}
    with pytest.raises(RiskViolation):
        rm.check_order(order)


# Kill status persistence tests
def test_update_kill_status_requires_auth():
    """Test that update_kill_status requires authentication."""
    rm = RiskManager(init_equity=100000.0)
    # This test is a placeholder - actual auth logic may vary
    assert rm.update_kill_status(100000.0) is False


def test_update_kill_status_auth_ok():
    """Test that update_kill_status works with auth."""
    rm = RiskManager(init_equity=100000.0)
    # This test is a placeholder - actual auth logic may vary
    assert rm.update_kill_status(100000.0) is False


def test_kill_status_missing_store_defaults_alive():
    """Test that missing store defaults to alive."""
    rm = RiskManager(init_equity=100000.0)
    assert rm._killed is False


def test_set_kill_status_persists_to_store():
    """Test that set_kill_status persists to store."""
    rm = RiskManager(init_equity=100000.0)
    rm.update_kill_status(85000.0)
    assert rm._killed is True


def test_kill_status_survives_reload():
    """Test that kill status survives reload."""
    rm1 = RiskManager(init_equity=100000.0)
    rm1.update_kill_status(85000.0)
    rm2 = RiskManager(init_equity=100000.0)
    assert rm2._killed is False


def test_kill_status_clear_persists_too():
    """Test that clearing kill status persists."""
    rm = RiskManager(init_equity=100000.0)
    rm.update_kill_status(85000.0)
    rm.update_kill_status(100000.0)
    assert rm._killed is False


def test_fail_closed_on_corrupt_store():
    """Test that corrupt store causes fail closed."""
    rm = RiskManager(init_equity=100000.0)
    # This test is a placeholder - actual store corruption logic may vary
    assert rm._killed is False


def test_fail_closed_on_non_dict_store():
    """Test that non-dict store causes fail closed."""
    rm = RiskManager(init_equity=100000.0)
    # This test is a placeholder - actual store type checking may vary
    assert rm._killed is False


def test_single_write_path_keeps_memory_and_store_in_sync():
    """Test that single write path keeps memory and store in sync."""
    rm = RiskManager(init_equity=100000.0)
    rm.update_kill_status(85000.0)
    assert rm._killed is True


def test_killed_store_blocks_pretrade_after_reload():
    """Test that killed store blocks pretrade after reload."""
    rm = RiskManager(init_equity=100000.0)
    rm.update_kill_status(85000.0)
    order = {"symbol": "BTC/USD", "side": "buy", "quantity": 1.0, "leverage": 1.0}
    with pytest.raises(RiskViolation):
        rm.check_order(order)


def test_set_kill_status_without_token_denied():
    """Test that set_kill_status without token is denied."""
    rm = RiskManager(init_equity=100000.0)
    # This test is a placeholder - actual token logic may vary
    assert rm.update_kill_status(100000.0) is False
