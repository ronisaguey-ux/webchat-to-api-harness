class RiskError(Exception):
    pass

_killed = False

def is_killed() -> bool:
    """Return whether the kill switch is active."""
    return _killed

def set_kill_switch(active: bool):
    """Set the kill switch state (for testing/control)."""
    global _killed
    _killed = active

def get_max_notional() -> float:
    # Dummy implementation
    return 1000000.0

def get_max_leverage() -> float:
    # Dummy implementation
    return 10.0

def validate_pre_trade(order):
    """Validate a pre-trade order. Kill switch is the first check."""
    if is_killed():
        raise RiskError('trading halted by kill switch')
    # Existing checks
    max_notional = get_max_notional()
    max_leverage = get_max_leverage()
    # Placeholder: actual checks would go here
    # For demo, just pass if not killed
    return True
