import os
import pytest
from oculus.api_auth import get_jwt_secret

def test_get_jwt_secret_success():
    os.environ["JWT_SECRET"] = "a" * 32
    bearer = "bearer123"
    secret = get_jwt_secret(bearer)
    assert secret == os.environ["JWT_SECRET"]

def test_get_jwt_secret_missing():
    os.environ.pop("JWT_SECRET", None)
    with pytest.raises(RuntimeError, match="JWT_SECRET must be an independent high-entropy secret"):
        get_jwt_secret("bearer")

def test_get_jwt_secret_too_short():
    os.environ["JWT_SECRET"] = "short"
    with pytest.raises(RuntimeError, match="JWT_SECRET must be an independent high-entropy secret"):
        get_jwt_secret("bearer")

def test_get_jwt_secret_equals_bearer():
    os.environ["JWT_SECRET"] = "same" * 8  # 32 chars
    bearer = "same" * 8
    with pytest.raises(RuntimeError, match="JWT_SECRET must not equal the bearer API token"):
        get_jwt_secret(bearer)
