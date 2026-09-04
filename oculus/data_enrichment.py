"""
Data enrichment utilities for Oculus historical_data.
Provides functions for adding derived features like lags, rolling statistics, and indicators.
"""

import pandas as pd
from typing import List, Optional, Dict, Any


def add_lag_features(df: pd.DataFrame, column: str, lags: List[int]) -> pd.DataFrame:
    """
    Add lagged versions of a column to the DataFrame.
    """
    for lag in lags:
        df[f"{column}_lag{lag}"] = df[column].shift(lag)
    return df


def add_rolling_stats(df: pd.DataFrame, column: str, windows: List[int], stats: List[str] = ['mean', 'std']) -> pd.DataFrame:
    """
    Add rolling statistics (mean, std, etc.) for a column.
    """
    for window in windows:
        for stat in stats:
            if stat == 'mean':
                df[f"{column}_rolling{window}_mean"] = df[column].rolling(window).mean()
            elif stat == 'std':
                df[f"{column}_rolling{window}_std"] = df[column].rolling(window).std()
            elif stat == 'min':
                df[f"{column}_rolling{window}_min"] = df[column].rolling(window).min()
            elif stat == 'max':
                df[f"{column}_rolling{window}_max"] = df[column].rolling(window).max()
    return df


def add_pct_change(df: pd.DataFrame, column: str, periods: List[int]) -> pd.DataFrame:
    """
    Add percentage change columns.
    """
    for period in periods:
        df[f"{column}_pct_change_{period}"] = df[column].pct_change(period)
    return df


def enrich_historical_data(df: pd.DataFrame, config: Optional[Dict[str, Any]] = None) -> pd.DataFrame:
    """
    Apply a set of enrichment operations based on a configuration dict.
    Config example:
        {
            "lags": {"price": [1, 2, 3]},
            "rolling": {"volume": {"windows": [5, 10], "stats": ["mean", "std"]}},
            "pct_change": {"price": [1, 5]}
        }
    """
    if config is None:
        return df
    result = df.copy()
    if "lags" in config:
        for col, lags in config["lags"].items():
            result = add_lag_features(result, col, lags)
    if "rolling" in config:
        for col, params in config["rolling"].items():
            windows = params.get("windows", [])
            stats = params.get("stats", ["mean", "std"])
            result = add_rolling_stats(result, col, windows, stats)
    if "pct_change" in config:
        for col, periods in config["pct_change"].items():
            result = add_pct_change(result, col, periods)
    return result
