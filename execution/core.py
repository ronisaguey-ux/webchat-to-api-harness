import os
import time
from typing import Optional, Dict, Any
import logging

logger = logging.getLogger(__name__)

class AuthError(Exception):
    pass

def validate_token(auth_header: Optional[str]) -> Dict[str, Any]:
    """
    Validate Bearer token. Returns decoded token payload.
    Raises AuthError on invalid or missing token.
    """
    if not auth_header:
        raise AuthError("Missing authorization header")
    parts = auth_header.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise AuthError("Invalid authorization header format; expected 'Bearer <token>'")
    token = parts[1]
    # For demo: validate against env-expected token (or use JWT)
    expected = os.getenv("API_BEARER_TOKEN", "test-token")
    if token != expected:
        raise AuthError("Invalid token")
    # In production, decode JWT and check expiry etc.
    return {"caller_id": "demo_user", "scope": "trading"}

def require_auth(func):
    """Decorator to enforce authentication on execution endpoints."""
    def wrapper(*args, **kwargs):
        # Expect auth_header as a keyword argument or fallback to first arg?
        # We'll enforce it as a keyword argument for clarity.
        auth_header = kwargs.get('auth_header')
        if auth_header is None:
            raise AuthError("Missing authorization header (provide auth_header keyword argument)")
        payload = validate_token(auth_header)
        kwargs['caller_id'] = payload.get('caller_id')
        return func(*args, **kwargs)
    return wrapper

class ExecutionEngine:
    def __init__(self):
        self.orders = []

    @require_auth
    def place_order(self, symbol: str, quantity: float, price: float, auth_header: Optional[str] = None, caller_id: str = None) -> Dict:
        """Place a new order. Authentication required."""
        logger.info(f"Order placed by {caller_id}: {symbol} {quantity} @ {price}")
        order = {"symbol": symbol, "quantity": quantity, "price": price, "status": "pending"}
        self.orders.append(order)
        return order

    @require_auth
    def emergency_liquidate_all(self, auth_header: Optional[str] = None, caller_id: str = None) -> Dict:
        """Emergency liquidation of all positions. Authentication and rate-limiting should be enforced."""
        logger.warning(f"Emergency liquidation triggered by {caller_id}")
        return {"status": "liquidated", "caller": caller_id}
