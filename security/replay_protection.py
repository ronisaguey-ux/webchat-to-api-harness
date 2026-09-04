import hashlib
import hmac
import time
from typing import Any, Dict


class ReplayGuard:
    def __init__(self, secret: bytes, max_age: int = 60):
        self.secret = secret
        self.max_age = max_age
        self._seen_nonces = set()

    def verify(self, envelope: Dict[str, Any]) -> bool:
        required = ("nonce", "timestamp", "hmac")
        if not all(k in envelope for k in required):
            return False
        nonce = envelope["nonce"]
        timestamp = envelope["timestamp"]
        provided_hmac = envelope["hmac"]

        now = int(time.time())
        if abs(now - timestamp) > self.max_age:
            return False

        message = f"{nonce}:{timestamp}".encode("utf-8")
        expected_hmac = hmac.new(self.secret, message, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(provided_hmac, expected_hmac):
            return False

        if nonce in self._seen_nonces:
            return False
        self._seen_nonces.add(nonce)
        return True
