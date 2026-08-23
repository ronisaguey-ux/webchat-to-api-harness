import time
from typing import Dict, Any

# Simple nonce store to prevent replay attacks
_nonce_store: Dict[str, float] = {}

async def websocket_handler(websocket, path):
    """
    WebSocket upgrade handler with mandatory nonce+timestamp validation.
    The nonce is bound to the token, not the session_id.
    """
    # Extract token from query parameters or headers (example: from query string)
    token = websocket.request.query_params.get('token')
    if not token:
        await websocket.close(code=4401, reason="Missing token")
        return

    # Mandatory nonce and timestamp headers
    nonce = websocket.headers.get("X-Nonce")
    timestamp_str = websocket.headers.get("X-Timestamp")
    if not nonce or not timestamp_str:
        await websocket.close(code=4401, reason="Missing X-Nonce or X-Timestamp")
        return

    try:
        ts = float(timestamp_str)
        if abs(time.time() - ts) > 60:
            await websocket.close(code=4401, reason="Timestamp expired")
            return
        # Bind to the token (stable across connections) instead of session_id
        key = f"ws:{token}:{nonce}"
        if key in _nonce_store:
            await websocket.close(code=4401, reason="Nonce already used")
            return
        _nonce_store[key] = time.time()
    except ValueError:
        await websocket.close(code=4401, reason="Invalid timestamp")
        return

    # Proceed with WebSocket connection (placeholder)
    await websocket.send("Connection established")
    # Further message handling would go here
