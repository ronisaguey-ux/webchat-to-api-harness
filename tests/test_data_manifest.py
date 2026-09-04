import pytest
import json
import tempfile
import os
from oculus.run_manifest import build_manifest, validate_manifest
def test_build_manifest():
    with tempfile.TemporaryDirectory() as tmpdir:
        open(os.path.join(tmpdir, "file1.csv"), 'w').close()
        open(os.path.join(tmpdir, "file2.csv"), 'w').close()
        manifest = build_manifest(tmpdir)
        assert manifest['version'] == '1.0'
        assert manifest['data_dir'] == tmpdir
        assert manifest['file_count'] == 2
        assert 'file1.csv' in manifest['files']
        assert 'file2.csv' in manifest['files']
def test_validate_manifest_valid():
    with tempfile.TemporaryDirectory() as tmpdir:
        manifest_data = {"version": "1.0", "data_dir": tmpdir, "file_count": 0}
        manifest_path = os.path.join(tmpdir, "manifest.json")
        with open(manifest_path, 'w') as f:
            json.dump(manifest_data, f)
        assert validate_manifest(manifest_path) is True
def test_validate_manifest_missing_key():
    with tempfile.TemporaryDirectory() as tmpdir:
        manifest_data = {"version": "1.0"}
        manifest_path = os.path.join(tmpdir, "manifest.json")
        with open(manifest_path, 'w') as f:
            json.dump(manifest_data, f)
        with pytest.raises(ValueError, match="Manifest missing required key: data_dir"):
            validate_manifest(manifest_path)
def test_validate_manifest_not_found():
    with pytest.raises(ValueError, match="Manifest file not found"):
        validate_manifest("/nonexistent/manifest.json")
