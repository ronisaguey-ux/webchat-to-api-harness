import hashlib
import hmac
from dataclasses import dataclass, field
from typing import Any

@dataclass
class Order:
    client_id: str
    idempotency_key: str
    idempotency_nonce: str
    client_sequence: int
    payload: dict[str, Any] = field(default_factory=dict)
    idempotency_signature: str = ""

    def payload_hash(self) -> str:
        # Simple hash of the payload dict for demonstration
        import json
        return hashlib.sha256(json.dumps(self.payload, sort_keys=True).encode()).hexdigest()

    def sign(self, secret: bytes) -> 'Order':
        payload = f"{self.client_id}.{self.idempotency_nonce}.{self.client_sequence}.{self.payload_hash()}"
        self.idempotency_signature = hmac.new(secret, payload.encode(), hashlib.sha256).hexdigest()
        return self
