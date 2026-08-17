import pytest
from live.risk_manager import validate_pre_trade, set_kill_switch, RiskError, is_killed

def test_validate_pre_trade_normal():
    set_kill_switch(False)
    # Should pass without error
    assert validate_pre_trade({}) is True

def test_validate_pre_trade_killed():
    set_kill_switch(True)
    with pytest.raises(RiskError, match="trading halted by kill switch"):
        validate_pre_trade({})
    # Reset for other tests
    set_kill_switch(False)

def test_is_killed_default():
    # Default should be False
    set_kill_switch(False)
    assert is_killed() is False

def test_set_kill_switch():
    set_kill_switch(True)
    assert is_killed() is True
    set_kill_switch(False)
    assert is_killed() is False
