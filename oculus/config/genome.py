import numpy as np

def _validate_finite(arr):
    """
    Validate that the array contains only finite numbers (no NaN or inf).
    Raises ValueError if any non-finite value is found.
    """
    if not np.all(np.isfinite(arr)):
        raise ValueError("Array contains non-finite values")

def load_genome(filepath):
    """
    Load a genome from a .npy file and validate that all values are finite.
    """
    data = np.load(filepath)
    _validate_finite(data)
    return data
