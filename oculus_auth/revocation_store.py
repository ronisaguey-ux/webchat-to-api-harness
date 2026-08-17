import json
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Set, Dict

class RevocationStore:
    def __init__(self, path: str, ttl_seconds: int = 2592000):
        self.path = Path(path)
        self.ttl_seconds = ttl_seconds
        self._lock = threading.RLock()
        self._revoked: Set[str] = set()
        self._timestamps: Dict[str, float] = {}
        self._load()

    def _load(self) -> None:
        """Load revocation store from file, pruning expired entries."""
        if not self.path.exists():
            self._revoked = set()
            self._timestamps = {}
            return
        try:
            with open(self.path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                # data format: {"revoked": {"token1": timestamp, ...}}
                self._timestamps = data.get("revoked", {})
                # Prune expired
                now = time.time()
                expired = [tok for tok, ts in self._timestamps.items() if now - ts > self.ttl_seconds]
                for tok in expired:
                    del self._timestamps[tok]
                self._revoked = set(self._timestamps.keys())
        except (FileNotFoundError, json.JSONDecodeError, KeyError):
            self._revoked = set()
            self._timestamps = {}

    def _persist(self) -> None:
        """Atomically write revocation store to file."""
        with self._lock:
            # Use a temporary file and rename for atomicity
            fd, tmp_path = tempfile.mkstemp(dir=self.path.parent, prefix=self.path.name + '.tmp')
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                json.dump({"revoked": self._timestamps}, f)
            os.rename(tmp_path, self.path)

    def revoke(self, token_id: str) -> None:
        """Revoke a token by its ID (or jti)."""
        with self._lock:
            self._timestamps[token_id] = time.time()
            self._revoked.add(token_id)
            self._persist()

    def is_revoked(self, token_id: str) -> bool:
        """Check if a token is revoked, pruning expired entries on access."""
        with self._lock:
            now = time.time()
            # Check and prune this token if expired
            if token_id in self._timestamps and now - self._timestamps[token_id] > self.ttl_seconds:
                del self._timestamps[token_id]
                self._revoked.discard(token_id)
                self._persist()
                return False
            return token_id in self._revoked

    def prune(self) -> None:
        """Manually prune expired entries."""
        with self._lock:
            now = time.time()
            expired = [tok for tok, ts in self._timestamps.items() if now - ts > self.ttl_seconds]
            for tok in expired:
                del self._timestamps[tok]
                self._revoked.discard(tok)
            if expired:
                self._persist()

    def list_revoked(self) -> Set[str]:
        """Return a copy of the revoked set."""
        with self._lock:
            return set(self._revoked)
