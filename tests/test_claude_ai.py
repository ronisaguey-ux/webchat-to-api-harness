import os
import pytest

def test_environment_variables_required():
    # Temporarily unset the variables if they are set
    deepseek_original = os.environ.pop("DEEPSEEK_API_KEY", None)
    anthropic_original = os.environ.pop("ANTHROPIC_API_KEY", None)
    try:
        with pytest.raises(RuntimeError, match="DEEPSEEK_API_KEY environment variable is required"):
            import scripts.claude_ai
    finally:
        # Restore if they were set
        if deepseek_original is not None:
            os.environ["DEEPSEEK_API_KEY"] = deepseek_original
        if anthropic_original is not None:
            os.environ["ANTHROPIC_API_KEY"] = anthropic_original

def test_environment_variables_set():
    os.environ["DEEPSEEK_API_KEY"] = "dummy"
    os.environ["ANTHROPIC_API_KEY"] = "dummy2"
    try:
        import scripts.claude_ai
        assert scripts.claude_ai.DEEPSEEK_API_KEY == "dummy"
        assert scripts.claude_ai.ANTHROPIC_API_KEY == "dummy2"
    finally:
        os.environ.pop("DEEPSEEK_API_KEY", None)
        os.environ.pop("ANTHROPIC_API_KEY", None)
