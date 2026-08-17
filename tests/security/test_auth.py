import pytest
import os
from execution.core import validate_token, AuthError, ExecutionEngine
from execution.portfolio_engine import PortfolioEngine

def test_validate_token_valid():
    os.environ["API_BEARER_TOKEN"] = "test-token"
    payload = validate_token("Bearer test-token")
    assert payload["caller_id"] == "demo_user"

def test_validate_token_missing():
    with pytest.raises(AuthError, match="Missing authorization header"):
        validate_token(None)

def test_validate_token_invalid_format():
    with pytest.raises(AuthError, match="Invalid authorization header format"):
        validate_token("Basic token")

def test_validate_token_wrong_token():
    os.environ["API_BEARER_TOKEN"] = "test-token"
    with pytest.raises(AuthError, match="Invalid token"):
        validate_token("Bearer wrong")

def test_execution_engine_place_order_requires_auth():
    engine = ExecutionEngine()
    with pytest.raises(AuthError):
        engine.place_order("AAPL", 10, 100)  # no auth header
    # Valid auth
    os.environ["API_BEARER_TOKEN"] = "test-token"
    result = engine.place_order("AAPL", 10, 100, auth_header="Bearer test-token")
    assert result["status"] == "pending"

def test_portfolio_engine_requires_auth():
    engine = PortfolioEngine()
    with pytest.raises(AuthError):
        engine.get_positions()
    os.environ["API_BEARER_TOKEN"] = "test-token"
    pos = engine.get_positions(auth_header="Bearer test-token")
    assert pos == {}
