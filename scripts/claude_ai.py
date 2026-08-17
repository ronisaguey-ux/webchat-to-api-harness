import os

DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY")
if not DEEPSEEK_API_KEY:
    raise RuntimeError("DEEPSEEK_API_KEY environment variable is required")

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")
if not ANTHROPIC_API_KEY:
    raise RuntimeError("ANTHROPIC_API_KEY environment variable is required")

# Example usage (placeholder)
def get_deepseek_key() -> str:
    return DEEPSEEK_API_KEY

def get_anthropic_key() -> str:
    return ANTHROPIC_API_KEY
