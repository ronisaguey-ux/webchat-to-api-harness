from enum import Enum
import time
from typing import Optional

class KillSwitchState(Enum):
    ARMED = 'armed'
    TRIGGERED = 'triggered'
    DISARMED = 'disarmed'

class TradingKillSwitch:
    def __init__(self, max_drawdown_pct: float = 5.0, max_consecutive_losses: int = 3, stale_data_seconds: float = 15.0):
        self.state = KillSwitchState.ARMED
        self.max_drawdown_pct = max_drawdown_pct
        self.max_consecutive_losses = max_consecutive_losses
        self.stale_data_seconds = stale_data_seconds
        self._start_equity: Optional[float] = None
        self._peak_equity: Optional[float] = None
        self._consecutive_losses: int = 0
        self._last_data_timestamp: Optional[float] = None

    def arm(self) -> None:
        """Arm the kill switch. Resets internal tracking."""
        self.state = KillSwitchState.ARMED
        self._start_equity = None
        self._peak_equity = None
        self._consecutive_losses = 0
        self._last_data_timestamp = time.time()

    def disarm(self) -> None:
        """Disarm the kill switch. Trading can proceed without triggering."""
        self.state = KillSwitchState.DISARMED

    def trigger(self) -> None:
        """Manually trigger the kill switch."""
        self.state = KillSwitchState.TRIGGERED

    def is_triggered(self) -> bool:
        """Return True if the kill switch is triggered."""
        return self.state == KillSwitchState.TRIGGERED

    def update_equity(self, equity: float) -> None:
        """Update current equity and check drawdown condition."""
        if self.state != KillSwitchState.ARMED:
            return
        if self._start_equity is None:
            self._start_equity = equity
            self._peak_equity = equity
            return
        if equity > self._peak_equity:
            self._peak_equity = equity
        # Drawdown from peak
        if self._peak_equity > 0:
            drawdown = (self._peak_equity - equity) / self._peak_equity * 100
            if drawdown >= self.max_drawdown_pct:
                self.trigger()

    def record_trade_result(self, profit: float) -> None:
        """Record a trade result (positive or negative) and track consecutive losses."""
        if self.state != KillSwitchState.ARMED:
            return
        if profit < 0:
            self._consecutive_losses += 1
            if self._consecutive_losses >= self.max_consecutive_losses:
                self.trigger()
        else:
            self._consecutive_losses = 0

    def update_data_timestamp(self, timestamp: float) -> None:
        """Update the timestamp of the last received market data."""
        self._last_data_timestamp = timestamp

    def check_data_freshness(self) -> None:
        """Check if data is stale and trigger if so."""
        if self.state != KillSwitchState.ARMED:
            return
        if self._last_data_timestamp is None:
            return
        if time.time() - self._last_data_timestamp > self.stale_data_seconds:
            self.trigger()

    def check(self, equity: Optional[float] = None, trade_profit: Optional[float] = None, data_timestamp: Optional[float] = None) -> None:
        """Convenience method to update state and check all conditions."""
        if self.state != KillSwitchState.ARMED:
            return
        if equity is not None:
            self.update_equity(equity)
        if trade_profit is not None:
            self.record_trade_result(trade_profit)
        if data_timestamp is not None:
            self.update_data_timestamp(data_timestamp)
        self.check_data_freshness()
