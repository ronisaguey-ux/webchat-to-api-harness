import os
import time
import logging
from typing import Dict, Any, List, Optional

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Rate limiting configuration
RATE_LIMIT_WINDOW = 60  # seconds
RATE_LIMIT_MAX = 10     # max requests per window per caller


class AuthError(Exception):
    """Raised when authentication fails."""
    pass


def validate_token(auth_header: Optional[str]) -> Dict[str, Any]:
    """
    Validate a Bearer token from an Authorization header.

    Returns a payload dict containing the authenticated caller_id.
    Raises AuthError on missing, malformed, or invalid tokens.
    """
    if auth_header is None:
        raise AuthError("Missing authorization header")
    if not isinstance(auth_header, str) or not auth_header.startswith("Bearer "):
        raise AuthError("Invalid authorization header format")
    token = auth_header[len("Bearer "):]
    expected_token = os.environ.get("API_BEARER_TOKEN", "default-secret")
    if token != expected_token:
        raise AuthError("Invalid token")
    return {"caller_id": "demo_user"}


class ExecutionEngine:
    def __init__(self):
        self._rate_limit_store: Dict[str, List[float]] = {}
        self._caller_sessions: Dict[str, bool] = {}  # simple session store

    def _validate_session(self, auth_header: Optional[str]) -> Dict[str, Any]:
        """
        Validate the Authorization header and mark the caller session active.
        Raises AuthError if invalid.
        """
        payload = validate_token(auth_header)
        caller_id = payload["caller_id"]
        self._caller_sessions[caller_id] = True
        return payload

    def _check_rate_limit(self, caller_id: str) -> bool:
        """
        Enforce rate limiting for the given caller_id.
        Returns True if allowed, raises RuntimeError if too many requests.
        """
        now = time.time()
        # Remove old timestamps
        if caller_id in self._rate_limit_store:
            timestamps = self._rate_limit_store[caller_id]
            timestamps = [t for t in timestamps if now - t < RATE_LIMIT_WINDOW]
            self._rate_limit_store[caller_id] = timestamps
            if len(timestamps) >= RATE_LIMIT_MAX:
                logger.warning(f"Rate limit exceeded for caller {caller_id}")
                raise RuntimeError(f"Rate limit exceeded for caller {caller_id}")
        else:
            self._rate_limit_store[caller_id] = []
        self._rate_limit_store[caller_id].append(now)
        return True

    def _audit_log(self, action: str, caller_id: str, details: Dict[str, Any]):
        """Write an audit log entry before any position mutation."""
        log_entry = {
            "timestamp": time.time(),
            "caller_id": caller_id,
            "action": action,
            "details": details
        }
        # In production, write to a secure audit log file or database
        logger.info(f"AUDIT: {log_entry}")
        # Optionally write to a file
        with open("audit.log", "a") as f:
            f.write(f"{log_entry}\n")

    def place_order(self, symbol: str, quantity: float, price: float,
                    auth_header: Optional[str] = None) -> Dict[str, Any]:
        payload = self._validate_session(auth_header)
        caller_id = payload["caller_id"]
        self._check_rate_limit(caller_id)
        self._audit_log("place_order", caller_id,
                        {"symbol": symbol, "quantity": quantity, "price": price})
        return {"status": "pending"}

    def cancel_order(self, order_id: str,
                     auth_header: Optional[str] = None) -> Dict[str, Any]:
        payload = self._validate_session(auth_header)
        caller_id = payload["caller_id"]
        self._check_rate_limit(caller_id)
        self._audit_log("cancel_order", caller_id, {"order_id": order_id})
        return {"status": "cancelled", "order_id": order_id}

    def get_order_status(self, order_id: str,
                         auth_header: Optional[str] = None) -> Dict[str, Any]:
        payload = self._validate_session(auth_header)
        caller_id = payload["caller_id"]
        self._check_rate_limit(caller_id)
        # Read-only action; still log for traceability
        self._audit_log("get_order_status", caller_id, {"order_id": order_id})
        return {"status": "filled", "order_id": order_id}

    def get_open_orders(self, auth_header: Optional[str] = None) -> List[Dict[str, Any]]:
        payload = self._validate_session(auth_header)
        caller_id = payload["caller_id"]
        self._check_rate_limit(caller_id)
        self._audit_log("get_open_orders", caller_id, {})
        return []

    def emergency_liquidate_all(self, auth_header: Optional[str] = None) -> Dict[str, Any]:
        """Emergency liquidation: validation, rate limiting, and audit log before mutation."""
        payload = self._validate_session(auth_header)
        caller_id = payload["caller_id"]
        self._check_rate_limit(caller_id)
        self._audit_log("emergency_liquidate_all", caller_id, {})
        # Perform liquidation logic
        return {"status": "liquidated", "positions": []}
