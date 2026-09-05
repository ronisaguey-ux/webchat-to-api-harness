"""Run manifest & deterministic seed registry (C1+C4).

Writes a forensic fingerprint at run start (config hash, version, environment,
master seed, per-file data checksums) and derives reproducible per-scope seeds
via blake2b so every stochastic subsystem is reconstructible from one integer.
"""
import copy
from contextlib import contextmanager
import hashlib
import json
import logging
import os
import platform
import tempfile
import shutil
from typing import Dict, Any, Iterator, Optional, Tuple

logger = logging.getLogger(__name__)

# Snapshot metadata for core Python modules
_PYTHON_SNAPSHOT: Dict[str, Any] = {}

def record_python_snapshot() -> Dict[str, Any]:
    """Record rollback commands and snapshot metadata for core Python modules."""
    import sys
    snapshot = {
        "python_version": sys.version,
        "modules": {name: getattr(mod, "__file__", None) for name, mod in sys.modules.items() if mod is not None and hasattr(mod, "__file__")},
        "snapshot_type": "core_python",
    }
    _PYTHON_SNAPSHOT.update(snapshot)
    return snapshot

def set_python_snapshot(snapshot: Dict[str, Any]) -> None:
    """Store a DEEP copy of the snapshot (callers may mutate their own copy)."""
    _PYTHON_SNAPSHOT.clear()
    _PYTHON_SNAPSHOT.update(copy.deepcopy(snapshot))

def get_python_snapshot() -> Dict[str, Any]:
    """Return a DEEP copy of the stored snapshot (defensive copy — STEP 1422/1558:
    mutating the returned dict must never corrupt the stored snapshot)."""
    return copy.deepcopy(_PYTHON_SNAPSHOT)

def clear_python_snapshot() -> None:
    """Clear the Python snapshot (useful for tests)."""
    _PYTHON_SNAPSHOT.clear()


@contextmanager
def python_snapshot(manifest: Any = None) -> Iterator[None]:
    """Scope snapshot state to a manifest run (STEP 459/1566)."""
    saved = copy.deepcopy(_PYTHON_SNAPSHOT)
    _PYTHON_SNAPSHOT.clear()
    try:
        yield
    finally:
        _PYTHON_SNAPSHOT.clear()
        _PYTHON_SNAPSHOT.update(saved)

MANIFEST_NAME = "run_manifest.json"


def _sha256_file(path: str, _chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(_chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def derive_seed(master_seed: int, scope: str) -> int:
    """Deterministic per-scope seed in [0, 2**128) via blake2b-128.

    STEP 1422/1558: the previous implementation imported a `seed_deriver`
    module (and `seed`) that never existed since the root commit — latent
    ImportError/NameError. The documented contract is reconstructed here
    with hashlib directly.
    """
    digest = hashlib.blake2b(f"{master_seed}:{scope}".encode(), digest_size=16).digest()
    return int.from_bytes(digest, "big")


def build_manifest(run_id: str, coin: str, config_path: str = "config.yaml",
                   data_files: Tuple[str, ...] = (), master_seed: int = 42) -> Dict[str, Any]:
    cfg_hash = _sha256_file(config_path) if os.path.exists(config_path) else None
    data_hashes = {}
    for p in data_files:
        key = os.path.relpath(p)  # full relative path: basename collisions must not silently drop entries
        if key in data_hashes:
            raise ValueError(f"duplicate data file key in manifest: {key}")
        try:
            data_hashes[key] = _sha256_file(p)
        except OSError as e:
            data_hashes[key] = f"unreadable:{e}"
    try:
        from oculus import __version__ as _ver
    except Exception:
        _ver = "unknown"
    return {
        "run_id": run_id,
        "coin": coin,
        "oculus_version": _ver,
        "python": platform.python_version(),
        "platform": platform.platform(),
        "config_path": os.path.abspath(config_path),
        "config_sha256": cfg_hash,
        "data_hashes": data_hashes,
        "master_seed": master_seed,
        "seed_scopes": {s: derive_seed(master_seed, s) for s in ("ga", "mutation", "crossover", "mc", "sabotage")},
        "env": {
            "OCULUS_CONFIG": os.environ.get("OCULUS_CONFIG"),
            "OCULUS_DATA_DIR": os.environ.get("OCULUS_DATA_DIR"),
            "OCULUS_CROSS_ASSET": os.environ.get("OCULUS_CROSS_ASSET"),
            "NUMBA_CACHE_DIR": os.environ.get("NUMBA_CACHE_DIR"),
            "OCULUS_REGIME_MODEL": os.environ.get("OCULUS_REGIME_MODEL"),
            "OCULUS_HOT_MUTATION_BOOST": os.environ.get("OCULUS_HOT_MUTATION_BOOST"),
            "OCULUS_API_TOKEN": "set" if os.environ.get("OCULUS_API_TOKEN") else None,  # no token material in manifests
            "OCULUS_HB_MAX_AGE": os.environ.get("OCULUS_HB_MAX_AGE"),
        },
    }


def write_run_manifest(run_id: str, coin: str, out_dir: str, config_path: str = "config.yaml",
                       data_files: Tuple[str, ...] = (), master_seed: int = 42) -> str:
    """Atomically write run_manifest.json into out_dir; returns its path."""
    os.makedirs(out_dir, exist_ok=True)
    manifest = build_manifest(run_id, coin, config_path, data_files, master_seed)
    path = os.path.join(out_dir, MANIFEST_NAME)
    tmp_fd, tmp_path = tempfile.mkstemp(dir=out_dir, suffix=".tmp")
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2, sort_keys=True)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
    logger.info(f"Run manifest written: {path}")
    return path


def main() -> None:
    """Main entry point for run_manifest module."""
    import argparse
    parser = argparse.ArgumentParser(description="Write a run manifest")
    parser.add_argument("--run-id", required=True, help="Run identifier")
    parser.add_argument("--coin", required=True, help="Coin symbol")
    parser.add_argument("--out-dir", required=True, help="Output directory")
    parser.add_argument("--config-path", default="config.yaml", help="Path to config file")
    parser.add_argument("--data-files", nargs="*", default=[], help="Data files to hash")
    parser.add_argument("--master-seed", type=int, default=42, help="Master seed")
    args = parser.parse_args()
    write_run_manifest(args.run_id, args.coin, args.out_dir, args.config_path, tuple(args.data_files), args.master_seed)


if __name__ == "__main__":
    main()
