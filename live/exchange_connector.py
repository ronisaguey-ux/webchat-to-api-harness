import os
import time
import uuid
from typing import Optional, Dict, Any

class ReplayAttackError(Exception):
    pass

class ExchangeConnector:
    _ORDER_NONCES: set[str] = set()

    def __init__(self):
        self.api_key = os.environ.get("BINANCE_API_KEY")
        self.api_secret = os.environ.get("BINANCE_API_SECRET")
        if not self.api_key:
            raise RuntimeError("BINANCE_API_KEY environment variable is required")
        if not self.api_secret:
            raise RuntimeError("BINANCE_API_SECRET environment variable is required")

    def place_order(self, symbol: str, side: str, amount: float, **kwargs) -> Dict[str, Any]:
        raw_nonce = kwargs.pop('idempotency_key', None) or uuid.uuid4().hex
        if raw_nonce in self._ORDER_NONCES:
            raise ReplayAttackError(f"replayed idempotency key {raw_nonce}")
        self._ORDER_NONCES.add(raw_nonce)
        client_timestamp = kwargs.get('client_timestamp')
        if client_timestamp is not None and abs(time.time() - client_timestamp) > 300:
            raise ReplayAttackError("order timestamp outside replay window")
        # Simulate placing order (placeholder)
        order_id = f"ord-{uuid.uuid4().hex[:8]}"
        return {"order_id": order_id, "symbol": symbol, "side": side, "amount": amount, "status": "placed"}
