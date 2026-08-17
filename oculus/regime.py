import os
import hmac
import hashlib

_HMAC_KEY_ENV = "OCULUS_REGIME_HMAC_KEY"

def _checkpoint_hmac_key() -> str | None:
    """Return HMAC key from environment or None if not set."""
    return os.getenv(_HMAC_KEY_ENV)

def _verify_model_file(file_path: str, expected_hmac: str) -> bool:
    """
    Verify that the model file contents match the expected HMAC.
    Raises RuntimeError if HMAC key not configured (mandatory).
    """
    key = _checkpoint_hmac_key()
    if key is None:
        raise RuntimeError(
            "HMAC key not configured; refusing to load unsigned regime model in production"
        )
    # In a real implementation, read file and compute HMAC, then compare to expected_hmac
    # For demo, we just simulate verification
    # Placeholder: assume verification succeeds if key is present
    return True

def _load_gmm_model(file_path: str, expected_hmac: str):
    """
    Load a GMM model after verifying its HMAC.
    Returns the model object (placeholder).
    """
    if not _verify_model_file(file_path, expected_hmac):
        raise RuntimeError("HMAC verification failed for regime model")
    # Placeholder: load model from file
    # For demo, return a dict
    return {"model": "loaded", "file": file_path}
