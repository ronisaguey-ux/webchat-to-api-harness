import pandas as pd
import numpy as np
from typing import Dict, Any, List, Optional

class DataManifest:
    def __init__(self, manifest_dict: Dict[str, Any]):
        self.schema = manifest_dict.get('schema', {})
        self.required_columns = manifest_dict.get('required_columns', [])
        self.nullable = manifest_dict.get('nullable', {})
        self.min_rows = manifest_dict.get('min_rows', 1)
        self.max_rows = manifest_dict.get('max_rows', None)
        self.custom_checks = manifest_dict.get('custom_checks', [])

    def validate_dataframe(self, df: pd.DataFrame) -> List[str]:
        errors = []
        for col in self.required_columns:
            if col not in df.columns:
                errors.append(f"Required column '{col}' missing.")
        for col, dtype in self.schema.items():
            if col in df.columns:
                if not pd.api.types.is_dtype_equal(df[col].dtype, dtype):
                    errors.append(f"Column '{col}' expected dtype {dtype}, got {df[col].dtype}")
        for col, nullable in self.nullable.items():
            if col in df.columns and not nullable:
                if df[col].isna().any():
                    errors.append(f"Column '{col}' contains nulls but is marked non-nullable.")
        if len(df) < self.min_rows:
            errors.append(f"DataFrame has {len(df)} rows, minimum required {self.min_rows}")
        if self.max_rows is not None and len(df) > self.max_rows:
            errors.append(f"DataFrame has {len(df)} rows, maximum allowed {self.max_rows}")
        return errors

def validate_historical_data(df: pd.DataFrame, manifest: DataManifest) -> bool:
    errors = manifest.validate_dataframe(df)
    if errors:
        raise ValueError(f"Data validation failed: {'; '.join(errors)}")
    return True

def heal_ohlcv(df: pd.DataFrame, timestamp_col: str = 'timestamp', sort_by: str = 'timestamp', fill_method: str = 'ffill') -> pd.DataFrame:
    """
    Composite API to heal common OHLCV data issues:
    - Ensure timestamp column exists and is datetime.
    - Sort by timestamp.
    - Fill missing values using specified method.
    - Drop duplicate timestamps (keep first).
    - Remove rows with NaN in critical columns (open, high, low, close, volume).
    """
    if df is None or len(df) == 0:
        return pd.DataFrame()
    result = df.copy()
    if timestamp_col not in result.columns:
        raise ValueError(f"Timestamp column '{timestamp_col}' not found.")
    result[timestamp_col] = pd.to_datetime(result[timestamp_col])
    result = result.sort_values(by=sort_by).reset_index(drop=True)
    result = result.drop_duplicates(subset=[timestamp_col], keep='first')
    # Use ffill/bfill explicitly to avoid method parameter issues in pandas >=2.0
    if fill_method == 'ffill':
        result = result.ffill()
    elif fill_method == 'bfill':
        result = result.bfill()
    else:
        # fallback: use fillna with value if method not recognized
        result = result.fillna(method=fill_method)
    critical_cols = ['open', 'high', 'low', 'close', 'volume']
    for col in critical_cols:
        if col in result.columns:
            result = result[result[col].notna()]
    return result
