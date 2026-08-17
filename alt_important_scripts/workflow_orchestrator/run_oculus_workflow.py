import os
from pathlib import Path

class TelegramBot:
    def __init__(self, state_dir: str):
        self.state_dir = Path(state_dir)
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.last_update_id = self._load_last_update_id()

    def _load_last_update_id(self) -> int:
        last_path = self.state_dir / "last_update_id"
        if last_path.exists():
            try:
                return int(last_path.read_text().strip())
            except ValueError:
                return 0
        return 0

    def _persist_state(self):
        last_path = self.state_dir / "last_update_id"
        last_path.write_text(str(self.last_update_id))

    def process_updates(self, updates):
        """Process a list of update objects, skipping those already processed."""
        for update in updates:
            update_id = getattr(update, 'update_id', None)
            if update_id is None:
                continue
            if update_id <= self.last_update_id:
                continue
            self.dispatch(update)
            if update_id > self.last_update_id:
                self.last_update_id = update_id
                self._persist_state()
        return True

    def dispatch(self, update):
        """Placeholder for actual command dispatching."""
        print(f"Dispatching update {update.update_id}")

    def run_polling(self, poll_func):
        while True:
            updates = poll_func()
            if updates:
                self.process_updates(updates)
