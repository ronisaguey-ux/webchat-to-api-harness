import pickle
import io
from typing import Any, Dict

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
    """
    with open(file_path, 'rb') as f:
        return _RestrictedUnpickler(f).load()

def save_checkpoint(data: Dict[str, Any], file_path: str) -> None:
    """Save checkpoint data using standard pickle (no restrictions)."""
    with open(file_path, 'wb') as f:
        pickle.dump(data, f)
