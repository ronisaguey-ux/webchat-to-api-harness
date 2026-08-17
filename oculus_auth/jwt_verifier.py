import time
from typing import Optional, Dict, Any
from .revocation_store import RevocationStore

class JWTVerifier:
    def __init__(self, revocation_store: RevocationStore):
        self.revocation_store = revocation_store

    def verify(self, token: str) -> Optional[Dict[str, Any]]:
        """
        Verify a JWT token. Returns decoded payload if valid and not revoked.
        This is a placeholder; a real implementation would decode JWT using a secret or public key.
        """
        # For demo, we assume the token is a simple string and extract a fake jti
        # In production, decode JWT with pyjwt, check signature, expiry, etc.
        # Here we simulate a valid token with a jti claim.
        try:
            # Fake decoding: expect token format "payload.jti"
            parts = token.split('.')
            if len(parts) < 2:
                raise ValueError("Invalid token format")
            jti = parts[1]  # second part as jti
            if self.revocation_store.is_revoked(jti):
                return None
            # Simulate payload
            return {"jti": jti, "sub": "user", "exp": time.time() + 3600}
        except Exception:
            return None
