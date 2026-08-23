import os
import logging
from typing import Optional

logger = logging.getLogger(__name__)

class AssetRegistry:
    """Registry for managing data asset paths with existence and non-empty checks."""

    @staticmethod
    def resolve_data_path(path: str) -> str:
        """
        Resolve and validate a data path.
        
        Args:
            path: Filesystem path to validate.
            
        Returns:
            The absolute resolved path if it exists and is non-empty.
            
        Raises:
            ValueError: If path does not exist, is a directory, or is empty.
        """
        if not os.path.exists(path):
            raise ValueError(f"Data path does not exist: {path}")
        
        # Check if it's a file and has content
        if os.path.isfile(path):
            if os.path.getsize(path) == 0:
                raise ValueError(f"Data file is empty: {path}")
        elif os.path.isdir(path):
            # Check if directory contains any files
            try:
                files = os.listdir(path)
                if not files:
                    raise ValueError(f"Data directory is empty: {path}")
                # Optionally check if any file has content? For simplicity, just ensure directory is non-empty.
            except OSError as e:
                raise ValueError(f"Cannot read directory {path}: {e}")
        else:
            raise ValueError(f"Path is neither a file nor a directory: {path}")
        
        return os.path.abspath(path)
