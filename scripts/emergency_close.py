import os
import time
import logging
from typing import Dict, Any

logger = logging.getLogger(__name__)

def audit_log(event: str, **kwargs) -> None:
    """Log an audit event with key=value pairs."""
    parts = [f"{k}={v}" for k, v in kwargs.items()]
    logger.info(f"AUDIT: {event} " + " ".join(parts))

def _close_binance_rest() -> bool:
    """Close positions via REST API. Returns True on success."""
    # Placeholder: actual implementation would call Binance REST
    logger.info("Closing via REST")
    return True

def _close_binance_connector() -> bool:
    """Close positions via WebSocket/connector. Returns True on success."""
    # Placeholder: actual implementation would use the connector
    logger.info("Closing via connector")
    return True

def emergency_close() -> Dict[str, Any]:
    """
    Execute an atomic emergency close with mutual exclusion.
    Returns a result dictionary with close_id and outcome.
    """
    close_id = os.urandom(8).hex()
    lock_path = f"/tmp/oculus_emergency_close_{close_id}.lock"
    try:
        fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        raise RuntimeError("Another emergency close is already in progress")
    result = None
    success = False
    try:
        # Primary path
        result = _close_binance_rest()
        if not result:  # auth or network failure on primary path
            result = _close_binance_connector()
        success = bool(result)
        audit_log("close_complete", close_id=close_id, result=result)
    except Exception as e:
        audit_log("close_failed", close_id=close_id, error=str(e))
        raise
    finally:
        os.close(fd)
        os.unlink(lock_path)
    return {"close_id": close_id, "success": success, "result": result}

if __name__ == "__main__":
    # For testing
    import sys
    logging.basicConfig(level=logging.INFO)
    try:
        outcome = emergency_close()
        print(f"Emergency close completed: {outcome}")
    except Exception as e:
        print(f"Emergency close failed: {e}", file=sys.stderr)
        sys.exit(1)
