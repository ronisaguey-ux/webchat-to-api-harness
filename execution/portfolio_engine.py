import logging
from typing import Dict, Optional
from execution.core import require_auth, AuthError

logger = logging.getLogger(__name__)

class PortfolioEngine:
    def __init__(self):
        self.positions = {}
        self.trades = []

    @require_auth
    def get_positions(self, auth_header: Optional[str] = None, caller_id: str = None) -> Dict:
        """Get current positions. Authentication required."""
        logger.info(f"Positions requested by {caller_id}")
        return self.positions

    @require_auth
    def execute_trade(self, symbol: str, quantity: float, side: str, auth_header: Optional[str] = None, caller_id: str = None) -> Dict:
        """Execute a trade. Authentication required."""
        logger.info(f"Trade executed by {caller_id}: {side} {quantity} {symbol}")
        trade = {"symbol": symbol, "quantity": quantity, "side": side, "status": "executed"}
        self.trades.append(trade)
        if symbol not in self.positions:
            self.positions[symbol] = 0
        if side.lower() == "buy":
            self.positions[symbol] += quantity
        elif side.lower() == "sell":
            self.positions[symbol] -= quantity
        return trade

    @require_auth
    def emergency_liquidate_all(self, auth_header: Optional[str] = None, caller_id: str = None) -> Dict:
        """Emergency liquidation. Authentication and audit required."""
        logger.warning(f"Portfolio emergency liquidation triggered by {caller_id}")
        liquidated = {symbol: qty for symbol, qty in self.positions.items() if qty != 0}
        self.positions.clear()
        return {"status": "liquidated", "liquidated_positions": liquidated, "caller": caller_id}
