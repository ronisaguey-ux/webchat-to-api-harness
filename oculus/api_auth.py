import os

def get_jwt_secret(bearer_token: str) -> str:
    """
    Get JWT signing secret from environment with security checks.
    Ensures secret is independent from the bearer token and has sufficient entropy.
    """
    secret = os.getenv("JWT_SECRET")
    if not secret or len(secret) < 32:
        raise RuntimeError("JWT_SECRET must be an independent high-entropy secret")
    if secret == bearer_token:
        raise RuntimeError("JWT_SECRET must not equal the bearer API token")
    return secret
