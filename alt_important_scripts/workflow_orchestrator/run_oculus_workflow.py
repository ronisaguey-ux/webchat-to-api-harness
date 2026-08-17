import os
from functools import wraps
from flask import Flask, request, abort
from pathlib import Path

app = Flask(__name__)
API_KEY = os.environ.get("OCULUS_API_KEY", "default-key")  # should be set in production

def require_api_key(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if request.headers.get("X-API-Key") != API_KEY:
            abort(401)
        return f(*args, **kwargs)
    return wrapper

@app.route("/webhook", methods=["POST"])
@require_api_key
def webhook():
    # Placeholder for webhook handling
    return {"status": "ok"}

# Original TelegramBot class (kept for compatibility)
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
        print(f"Dispatching update {update.update_id}")

    def run_polling(self, poll_func):
        while True:
            updates = poll_func()
            if updates:
                self.process_updates(updates)
