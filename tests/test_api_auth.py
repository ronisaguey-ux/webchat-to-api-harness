import os
import pytest
from oculus.api_auth import get_jwt_secret


def test_get_jwt_secret_valid():
    os.environ["JWT_SECRET"] = "a" * 32
    bearer = "some_bearer_token"
    secret = get_jwt_secret(bearer)
    assert secret == "a" * 32


def test_get_jwt_secret_missing():
    os.environ.pop("JWT_SECRET", None)
    with pytest.raises(RuntimeError, match="JWT_SECRET must be an independent high-entropy secret"):
        get_jwt_secret("token")


def test_get_jwt_secret_too_short():
    os.environ["JWT_SECRET"] = "short"
    with pytest.raises(RuntimeError, match="JWT_SECRET must be an independent high-entropy secret"):
        get_jwt_secret("token")


def test_get_jwt_secret_equals_bearer():
    os.environ["JWT_SECRET"] = "a" * 32
    bearer = "a" * 32
    with pytest.raises(RuntimeError, match="JWT_SECRET must not equal the bearer API token"):
        get_jwt_secret(bearer)


def test_refresh_token_disabled():
    # As per STEP 4, refresh tokens are disabled until rotation is implemented.
    # Check that the refresh_token function is not defined (or raises NotImplementedError).
    try:
        from oculus.api_auth import refresh_token
        # If it exists, calling it should raise NotImplementedError
        with pytest.raises(NotImplementedError):
            refresh_token("dummy")
    except ImportError:
        # Function not defined, which is acceptable as it's disabled.
        pass
