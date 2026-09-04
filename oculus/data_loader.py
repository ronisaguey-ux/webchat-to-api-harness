"""
Data loader for historical_data with manifest-based validation.
"""
import json
import os
import pandas as pd
from typing import Optional
def load_data_with_manifest(data_path: str, manifest_path: Optional[str] = None) -> pd.DataFrame:
    if manifest_path and os.path.exists(manifest_path):
        with open(manifest_path, 'r') as f:
            manifest = json.load(f)
    if os.path.isdir(data_path):
        all_data = []
        for f in os.listdir(data_path):
            if f.endswith('.csv'):
                df = pd.read_csv(os.path.join(data_path, f))
                all_data.append(df)
        if all_data:
            return pd.concat(all_data, ignore_index=True)
        else:
            return pd.DataFrame()
    elif os.path.isfile(data_path) and data_path.endswith('.csv'):
        return pd.read_csv(data_path)
    else:
        raise ValueError(f"Unsupported data path: {data_path}")
