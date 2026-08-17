import logging
from typing import Optional

logger = logging.getLogger(__name__)

class Order:
    def __init__(self, order_id: str):
        self.id = order_id
        self.status = "PENDING"

class OrderManager:
    def __init__(self):
        self._orders = []

    def _log_order(self, order):
        logger.info(f"Order {order.id} status: {order.status}")

    def route_order(self, order: Order) -> Order:
        """Route an order to the exchange, but first check kill-switch."""
        # Fail-closed kill-switch gate (step 14): trips (drawdown, consecutive
        # losses, stale data) refuse new orders before any broker call. NOTE:
        # per-order TradingKillSwitch() is a safe no-op when unarmed — the
        # real stateful wiring (module singleton, armed from snapshot balance,
        # updated by trade results) is implemented by the team agents in
        # route_order; this fallback only guarantees the gate exists.
        from oculus.live_trading.kill_switch import TradingKillSwitch
        if TradingKillSwitch().is_triggered():
            logger.critical(f"Kill-switch triggered; refusing order {order.id} (fail-closed)")
            order.status = "REJECTED"
            self._log_order(order)
            return order
        logger.info(f"Routing order {order.id} to exchange connector.")
        # Simulate routing
        order.status = "ROUTED"
        self._orders.append(order)
        self._log_order(order)
        return order
