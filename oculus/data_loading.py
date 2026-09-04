"""
Data loading and alignment utilities for Oculus.
"""

import pandas as pd
from typing import List, Dict, Any, Optional

def load_data(file_path: str, **kwargs) -> pd.DataFrame:
    """
    Load data from a file (CSV, Parquet, etc.) with optional parameters.
    """
    if file_path.endswith('.csv'):
        return pd.read_csv(file_path, **kwargs)
    elif file_path.endswith('.parquet'):
        return pd.read_parquet(file_path, **kwargs)
    else:
        raise ValueError(f"Unsupported file format: {file_path}")

def align_data(data: pd.DataFrame, target_index: Optional[pd.Index] = None, method: str = 'ffill') -> pd.DataFrame:
    """
    Align data to a target index using the specified method (ffill, bfill, linear, etc.).
    """
    if target_index is None:
        return data
    return data.reindex(target_index, method=method)
