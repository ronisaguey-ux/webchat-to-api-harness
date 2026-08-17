import json
import math
import os
import threading
from typing import Optional

class RiskManager:
    def __init__(self, init_equity: float, daily_dd_limit: float, state_file: Optional[str] = None):
        self._lock = threading.RLock()
        self._kill_state_file = state_file or os.environ.get('OCULUS_KILL_STATE_FILE', 'kill_switch_state.json')
        self.kill_latch = self._load_kill_latch()
        self.kill_engaged = self.kill_latch
        self.daily_start_equity = init_equity if self._is_valid_equity(init_equity) else 0.0
        self._peak_equity = self.daily_start_equity
        self._daily_dd_limit = daily_dd_limit if daily_dd_limit > 0 else 0.05
        self._consecutive_losses = 0
        self._max_consecutive_losses = 3
        self._last_data_time = None
        self._stale_data_seconds = 15.0

    def _is_valid_equity(self, equity: float) -> bool:
        """Return True if equity is finite and non-negative."""
        return math.isfinite(equity) and equity >= 0

    def _load_kill_latch(self) -> bool:
        """Load kill latch state from file, default False."""
        try:
            with open(self._kill_state_file, 'r') as f:
                data = json.load(f)
                return data.get('kill_engaged', False)
        except (FileNotFoundError, json.JSONDecodeError):
            return False

    def _persist_kill_latch(self):
        """Persist kill latch state to file."""
        with open(self._kill_state_file, 'w') as f:
            json.dump({'kill_engaged': self.kill_engaged}, f)

    def engage_kill_switch(self):
        """Engage the kill switch persistently."""
        with self._lock:
            self.kill_engaged = True
            self.kill_latch = True
            self._persist_kill_latch()

    def disengage_kill_switch(self):
        """Disengage the kill switch (reset latch)."""
        with self._lock:
            self.kill_engaged = False
            self.kill_latch = False
            self._persist_kill_latch()

    def is_killed(self) -> bool:
        """Return True if kill switch is engaged."""
        with self._lock:
            return self.kill_engaged

    def update_equity(self, equity: float) -> None:
        """Update current equity, check drawdown and invalid inputs."""
        with self._lock:
            if not self._is_valid_equity(equity):
                self.engage_kill_switch()
                return
            if self.kill_engaged:
                return
            if self.daily_start_equity == 0:
                self.daily_start_equity = equity
                self._peak_equity = equity
                return
            if equity > self._peak_equity:
                self._peak_equity = equity
            drawdown = (self._peak_equity - equity) / self._peak_equity if self._peak_equity > 0 else 0
            if drawdown >= self._daily_dd_limit:
                self.engage_kill_switch()

    def record_trade_result(self, profit: float) -> None:
        """Record trade profit/loss, track consecutive losses."""
        with self._lock:
            if not math.isfinite(profit):
                self.engage_kill_switch()
                return
            if self.kill_engaged:
                return
            if profit < 0:
                self._consecutive_losses += 1
                if self._consecutive_losses >= self._max_consecutive_losses:
                    self.engage_kill_switch()
            else:
                self._consecutive_losses = 0

    def update_data_timestamp(self, timestamp: float) -> None:
        """Update last data timestamp."""
        with self._lock:
            self._last_data_time = timestamp

    def check_data_freshness(self, current_time: float) -> None:
        """Check if data is stale and engage kill if so."""
        with self._lock:
            if self.kill_engaged:
                return
            if self._last_data_time is None:
                return
            if current_time - self._last_data_time > self._stale_data_seconds:
                self.engage_kill_switch()

    def reset(self, init_equity: float):
        """Reset risk manager state (does not disarm kill switch)."""
        with self._lock:
            if self.kill_engaged:
                return
            if self._is_valid_equity(init_equity):
                self.daily_start_equity = init_equity
                self._peak_equity = init_equity
                self._consecutive_losses = 0
                self._last_data_time = None
