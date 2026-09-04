import numpy as np
import tempfile
import pytest
from oculus.config.genome import _validate_finite, load_genome


def test_validate_finite_valid():
    arr = np.array([1.0, 2.5, -3.2])
    # Should not raise
    _validate_finite(arr)


def test_validate_finite_with_nan():
    arr = np.array([1.0, np.nan, 2.0])
    with pytest.raises(ValueError, match="Array contains non-finite values"):
        _validate_finite(arr)


def test_validate_finite_with_inf():
    arr = np.array([1.0, np.inf, 2.0])
    with pytest.raises(ValueError, match="Array contains non-finite values"):
        _validate_finite(arr)


def test_load_genome_valid():
    data = np.array([1.0, 2.0, 3.0])
    with tempfile.NamedTemporaryFile(suffix=".npy", delete=False) as tmp:
        np.save(tmp, data)
        path = tmp.name
    try:
        loaded = load_genome(path)
        np.testing.assert_array_equal(loaded, data)
    finally:
        import os
        os.unlink(path)


def test_load_genome_invalid():
    data = np.array([1.0, np.nan, 3.0])
    with tempfile.NamedTemporaryFile(suffix=".npy", delete=False) as tmp:
        np.save(tmp, data)
        path = tmp.name
    try:
        with pytest.raises(ValueError, match="Array contains non-finite values"):
            load_genome(path)
    finally:
        import os
        os.unlink(path)
