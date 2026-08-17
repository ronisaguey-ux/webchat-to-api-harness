import pytest
import json
import tempfile
import os
from weight_store import WeightStore, WeightStoreIntegrityError

def test_valid_weight_store():
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
        json.dump({"key": "value"}, f)
        f.flush()
        ws = WeightStore(f.name)
        data = ws.open_weight_store()
        assert data == {"key": "value"}
    os.unlink(f.name)

def test_invalid_json():
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
        f.write("invalid json")
        f.flush()
        ws = WeightStore(f.name)
        with pytest.raises(WeightStoreIntegrityError, match="Invalid JSON"):
            ws.open_weight_store()
    os.unlink(f.name)

def test_missing_file():
    ws = WeightStore("/nonexistent/path")
    with pytest.raises(WeightStoreIntegrityError, match="Failed to open"):
        ws.open_weight_store()
