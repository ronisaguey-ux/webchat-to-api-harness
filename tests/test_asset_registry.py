import os
import tempfile
import pytest
from oculus.asset_registry import AssetRegistry


def test_resolve_data_path_file_exists_nonempty():
    with tempfile.NamedTemporaryFile(mode='w', delete=False) as f:
        f.write("some data")
        path = f.name
    try:
        resolved = AssetRegistry.resolve_data_path(path)
        assert resolved == os.path.abspath(path)
    finally:
        os.unlink(path)


def test_resolve_data_path_file_empty_raises():
    with tempfile.NamedTemporaryFile(mode='w', delete=False) as f:
        # leave empty
        path = f.name
    try:
        with pytest.raises(ValueError, match="Data file is empty"):
            AssetRegistry.resolve_data_path(path)
    finally:
        os.unlink(path)


def test_resolve_data_path_directory_nonempty():
    with tempfile.TemporaryDirectory() as tmpdir:
        # Create a file inside to make non-empty
        with open(os.path.join(tmpdir, "test.txt"), 'w') as f:
            f.write("content")
        resolved = AssetRegistry.resolve_data_path(tmpdir)
        assert resolved == os.path.abspath(tmpdir)


def test_resolve_data_path_directory_empty_raises():
    with tempfile.TemporaryDirectory() as tmpdir:
        # directory is empty
        with pytest.raises(ValueError, match="Data directory is empty"):
            AssetRegistry.resolve_data_path(tmpdir)


def test_resolve_data_path_nonexistent_raises():
    with pytest.raises(ValueError, match="Data path does not exist"):
        AssetRegistry.resolve_data_path("/nonexistent/path/that/does/not/exist")


def test_resolve_data_path_symlink_to_file():
    with tempfile.NamedTemporaryFile(mode='w', delete=False) as f:
        f.write("data")
        target = f.name
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            link = os.path.join(tmpdir, "link")
            os.symlink(target, link)
            resolved = AssetRegistry.resolve_data_path(link)
            assert resolved == os.path.abspath(link)  # returns the link path? Actually it returns absolute path of the path given, which is the symlink itself. That's fine.
    finally:
        os.unlink(target)
