"""
Manifest building and validation for historical_data corpus.
"""
import json
import os
from typing import Dict, Any
def build_manifest(data_dir: str) -> Dict[str, Any]:
    if not os.path.isdir(data_dir):
        raise ValueError(f"Data directory not found: {data_dir}")
    files = os.listdir(data_dir)
    manifest = {
        "version": "1.0",
        "data_dir": data_dir,
        "file_count": len(files),
        "files": files
    }
    return manifest
def validate_manifest(manifest_path: str) -> bool:
    if not os.path.exists(manifest_path):
        raise ValueError(f"Manifest file not found: {manifest_path}")
    with open(manifest_path, 'r') as f:
        manifest = json.load(f)
    required_keys = ['version', 'data_dir', 'file_count']
    for key in required_keys:
        if key not in manifest:
            raise ValueError(f"Manifest missing required key: {key}")
    if not isinstance(manifest.get('file_count'), int):
        raise ValueError("'file_count' must be an integer")
    return True
