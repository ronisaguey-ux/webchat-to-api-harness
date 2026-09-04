import os
import time
import logging
from typing import Dict, Any, List, Optional

from execution.core import validate_token, AuthError

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Rate limiting configuration (shared with core if needed)
RATE_LIMIT_WINDOW = 60
RATE_LIMIT_MAX = 10

class PortfolioEngine:
    def __init__(self):
        self._rate_limit_store: Dict[str, List[float]] = {}
        self._caller_sessions: Dict[str, bool] = {}
        self.positions: Dict[str, Any] = {}

    def _validate_session(self, caller_id: str, token: str) -> bool:
        expected_token = os.environ.get("EXECUTION_API_TOKEN", "default-secret")
        if token != expected_token:
            logger.warning(f"Invalid token from caller {caller_id}")
            raise PermissionError(f"Invalid authentication token for caller {caller_id}")
        self._caller_sessions[caller_id] = True
        return True

    def _check_rate_limit(self, caller_id: str) -> bool:
        now = time.time()
        if caller_id in self._rate_limit_store:
            timestamps = [t for t in self._rate_limit_store[caller_id] if now - t < RATE_LIMIT_WINDOW]
            self._rate_limit_store[caller_id] = timestamps
            if len(timestamps) >= RATE_LIMIT_MAX:
                logger.warning(f"Rate limit exceeded for caller {caller_id}")
                raise RuntimeError(f"Rate limit exceeded for caller {caller_id}")
        else:
            self._rate_limit_store[caller_id] = []
        self._rate_limit_store[caller_id].append(now)
        return True

    def _audit_log(self, action: str, caller_id: str, details: Dict[str, Any]):
        log_entry = {
            "timestamp": time.time(),
            "caller_id": caller_id,
            "action": action,
            "details": details
        }
        logger.info(f"AUDIT: {log_entry}")
        with open("audit.log", "a") as f:
            f.write(f"{log_entry}\n")

    def get_positions(self, auth_header: Optional[str] = None) -> Dict[str, Any]:
        payload = validate_token(auth_header)
        return self.positions

    def get_portfolio(self, caller_id: str, token: str) -> Dict[str, Any]:
        self._validate_session(caller_id, token)
        self._check_rate_limit(caller_id)
        self._audit_log("get_portfolio", caller_id, {})
        return self.positions

    def update_position(self, caller_id: str, token: str, symbol: str, quantity: float) -> Dict[str, Any]:
        self._validate_session(caller_id, token)
        self._check_rate_limit(caller_id)
        self._audit_log("update_position", caller_id, {"symbol": symbol, "quantity": quantity})
        self.positions[symbol] = quantity
        return {"status": "updated", "symbol": symbol, "quantity": quantity}

    def emergency_liquidate_all(self, caller_id: str, token: str) -> Dict[str, Any]:
        """Emergency liquidation: validates caller_id, enforces rate limiting, and writes audit log before mutation."""
        self._validate_session(caller_id, token)
        self._check_rate_limit(caller_id)
        self._audit_log("emergency_liquidate_all", caller_id, {})
        # Perform liquidation: clear all positions
        self.positions.clear()
        return {"status": "liquidated", "positions": self.positions}
