import pickle
import io
from typing import Any, Dict

class CheckpointCorruptionError(pickle.UnpicklingError):
    """Raised when a checkpoint file is corrupted or malicious."""
    pass

class _RestrictedUnpickler(pickle.Unpickler):
    """
    Restricted unpickler that only allows safe built-in types.
    Prevents arbitrary code execution via crafted pickle files.
    """
    def find_class(self, module: str, name: str) -> Any:
        # Only allow a small set of safe classes.
        allowed = {
            ('builtins', 'dict'),
            ('builtins', 'list'),
            ('builtins', 'tuple'),
            ('builtins', 'str'),
            ('builtins', 'int'),
            ('builtins', 'float'),
            ('builtins', 'bool'),
            ('builtins', 'NoneType'),
            ('numpy', 'ndarray'),   # allow numpy arrays if used in checkpoints
        }
        if (module, name) in allowed:
            return super().find_class(module, name)
        raise pickle.UnpicklingError(f"Forbidden class: {module}.{name}")

def load_checkpoint(file_path: str) -> Dict[str, Any]:
    """
    Load a checkpoint file using restricted unpickling.
    Returns the data dictionary.
    Raises CheckpointCorruptionError on corrupt or malicious checkpoints.
    """
    with open(file_path, 'rb') as f:
        data = f.read()
    try:
        return _RestrictedUnpickler(io.BytesIO(data)).load()
    except (pickle.UnpicklingError, EOFError, AttributeError, ImportError, IndexError) as exc:
        raise CheckpointCorruptionError(f"refusing to load corrupted checkpoint: {exc}") from exc

def save_checkpoint(data: Dict[str, Any], file_path: str) -> None:
    """Save checkpoint data using standard pickle (no restrictions)."""
    with open(file_path, 'wb') as f:
        pickle.dump(data, f)
