import os
import json
import logging
import stat
from pathlib import Path


class WeightStoreIntegrityError(Exception):
    """Raised when weight store integrity check fails."""
    pass


class WeightStore:
    def __init__(self, path: str):
        self.path = Path(path)
        self._data = None

    def verify_integrity(self) -> bool:
        """
        Verify integrity of the weight store file.
        Raises WeightStoreIntegrityError if invalid.
        Returns True if valid.
        """
        # TOCTOU-safe: open once with O_NOFOLLOW, then fstat the opened fd
        # and read from that same fd. Never re-open by path afterward.
        try:
            fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW)
        except OSError as e:
            raise WeightStoreIntegrityError(f"Failed to open weight store: {e}")

        try:
            # fstat the already-open fd so we inspect the file we will read.
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode):
                raise WeightStoreIntegrityError("Weight store is not a regular file")

            # Read the entire file via the fd we already hold (no path re-open).
            chunks = []
            while True:
                chunk = os.read(fd, 65536)
                if not chunk:
                    break
                chunks.append(chunk)
            raw = b"".join(chunks)

            data = json.loads(raw.decode("utf-8"))

            if not isinstance(data, dict):
                raise WeightStoreIntegrityError("Weight store data must be a dict")

            self._data = data
            return True

        except json.JSONDecodeError as e:
            raise WeightStoreIntegrityError(f"Invalid JSON in weight store: {e}")

        except WeightStoreIntegrityError:
            raise

        except Exception as e:
            raise WeightStoreIntegrityError(f"Integrity check failed: {e}")

        finally:
            # We own the fd and never handed it to fdopen, so close it here.
            os.close(fd)

    def open_weight_store(self) -> dict:
        """
        Open and load weight store, verifying integrity first.
        Returns the data dict if valid.
        """
        if self.verify_integrity():
            return self._data
        else:
            raise WeightStoreIntegrityError("Weight store integrity check failed; refusing to load")


# Example usage (for testing):
if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python weight_store.py <path_to_weight_file>")
        sys.exit(1)
    ws = WeightStore(sys.argv[1])
    try:
        data = ws.open_weight_store()
        print("Loaded weight store successfully.")
    except WeightStoreIntegrityError as e:
        print(f"Error: {e}")
        sys.exit(1)
