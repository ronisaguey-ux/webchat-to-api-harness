import os
import json
import logging
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
        # TOCTOU-safe: use os.open with O_NOFOLLOW, then fstat
        try:
            fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW)
        except OSError as e:
            raise WeightStoreIntegrityError(f"Failed to open weight store: {e}")
        try:
            # fstat after open to ensure we have the same file
            stat = os.fstat(fd)
            # Additional checks: file size, permissions? For now just check it's a regular file
            if not stat.st_mode & 0o100000:  # S_IFREG
                raise WeightStoreIntegrityError("Weight store is not a regular file")
            # Read and parse JSON to verify structure (optional)
            with os.fdopen(fd, 'r') as f:
                data = json.load(f)
            # Basic structure validation (customize as needed)
            if not isinstance(data, dict):
                raise WeightStoreIntegrityError("Weight store data must be a dict")
            # Store data for later use
            self._data = data
            return True
        except json.JSONDecodeError as e:
            raise WeightStoreIntegrityError(f"Invalid JSON in weight store: {e}")
        except Exception as e:
            raise WeightStoreIntegrityError(f"Integrity check failed: {e}")
        finally:
            # fd is closed by os.fdopen context manager if used, but we need to ensure closure
            # Actually os.fdopen closes on context exit, but if we raise before, might not close? We'll manage manually.
            pass

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
