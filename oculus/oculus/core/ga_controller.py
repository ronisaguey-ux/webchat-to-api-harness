"""
GA Controller with manifest validation for historical_data.
"""

import json
import os
from typing import Dict, Any, List

def validate_manifest(manifest_path: str) -> bool:
    """
    Validate the manifest file for historical_data.
    Checks that required keys exist and values are of expected types.
    Raises ValueError on failure, returns True on success.
    """
    if not os.path.exists(manifest_path):
        raise ValueError(f"Manifest file not found: {manifest_path}")
    with open(manifest_path, 'r') as f:
        manifest = json.load(f)
    # Basic validation: must contain 'columns' and 'version'
    if 'columns' not in manifest:
        raise ValueError("Manifest missing 'columns' key")
    if not isinstance(manifest['columns'], list):
        raise ValueError("'columns' must be a list")
    if 'version' not in manifest:
        raise ValueError("Manifest missing 'version' key")
    # Optionally check data types
    return True
