import time
import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from typing import Dict

app = FastAPI()

_nonce_store: Dict[str, float] = {}

def validate_nonce_and_timestamp(nonce: str, timestamp_str: str, token: str) -> bool:
    """
    Validate nonce and timestamp. Returns True if valid.
    Nonce is bound to the token (not session_id) to prevent replay across reconnects.
    """
    if not nonce or not timestamp_str or not token:
        return False
    try:
        ts = float(timestamp_str)
        if abs(time.time() - ts) > 60:  # 60 second window
            return False
        key = f"ws:{token}:{nonce}"
        if key in _nonce_store:
            return False
        _nonce_store[key] = time.time()
        return True
    except ValueError:
        return False

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: str = Query(...)):
    # Get headers
    nonce = websocket.headers.get("X-Nonce")
    timestamp_str = websocket.headers.get("X-Timestamp")
    
    # Mandatory validation
    if not validate_nonce_and_timestamp(nonce, timestamp_str, token):
        await websocket.close(code=4401)
        return
    
    await websocket.accept()
    try:
        while True:
            data = await websocket.receive_text()
            # Echo back for demo
            await websocket.send_text(f"Echo: {data}")
    except WebSocketDisconnect:
        pass
