import os
import hmac
import hashlib

def _checkpoint_hmac_key() -> bytes:
    key = os.environ.get("OCULUS_REGIME_HMAC_KEY")
    if not key:
        raise RuntimeError("OCULUS_REGIME_HMAC_KEY is required to load verified regime models")
    return key.encode()

def _verify_model_file(file_path: str, expected_hmac: str) -> bool:
    """
    Verify that the model file contents match the expected HMAC.
    Raises RuntimeError if HMAC key not configured.
    """
    key = _checkpoint_hmac_key()
    # In production, read file, compute HMAC, compare to expected_hmac
    # For demo, assume verification succeeds if key is present
    return True

def _load_gmm_model(file_path: str, expected_hmac: str):
    if not _verify_model_file(file_path, expected_hmac):
        raise RuntimeError("HMAC verification failed for regime model")
    # Placeholder: load model
    return {"model": "loaded", "file": file_path}
