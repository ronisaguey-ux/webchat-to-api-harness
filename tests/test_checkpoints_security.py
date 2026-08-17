import pytest
import pickle
import tempfile
import os
from oculus.checkpoints import load_checkpoint, save_checkpoint, _RestrictedUnpickler

class Malicious:
    def __reduce__(self):
        # This would execute arbitrary code if unpickled normally.
        # We expect it to be blocked by _RestrictedUnpickler.
        return (exec, ("print('malicious code executed')",))

def test_restricted_unpickler_blocks_malicious():
    # Create a pickle with a malicious class
    data = {"payload": Malicious()}
    with tempfile.NamedTemporaryFile(suffix='.pkl', delete=False) as f:
        pickle.dump(data, f)
        f.flush()
        fname = f.name
    try:
        with pytest.raises(pickle.UnpicklingError, match="Forbidden class"):
            load_checkpoint(fname)
    finally:
        os.unlink(fname)

def test_restricted_unpickler_allows_safe_types():
    data = {"weights": [0.1, -0.2], "name": "test", "value": 3.14, "flag": True}
    with tempfile.NamedTemporaryFile(suffix='.pkl', delete=False) as f:
        pickle.dump(data, f)
        f.flush()
        fname = f.name
    try:
        loaded = load_checkpoint(fname)
        assert loaded == data
    finally:
        os.unlink(fname)

def test_save_checkpoint():
    data = {"key": "value"}
    with tempfile.NamedTemporaryFile(suffix='.pkl', delete=False) as f:
        fname = f.name
    try:
        save_checkpoint(data, fname)
        loaded = load_checkpoint(fname)
        assert loaded == data
    finally:
        os.unlink(fname)
