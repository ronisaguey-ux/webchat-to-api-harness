import pytest
import pandas as pd
import numpy as np
from oculus.data_validation import heal_ohlcv

def test_heal_ohlcv_basic():
    df = pd.DataFrame({
        'timestamp': ['2024-01-01', '2024-01-02', '2024-01-03'],
        'open': [100, 101, 102],
        'high': [101, 102, 103],
        'low': [99, 100, 101],
        'close': [100.5, 101.5, 102.5],
        'volume': [1000, 1100, 1200]
    })
    result = heal_ohlcv(df)
    assert len(result) == 3
    assert 'timestamp' in result.columns
    assert pd.api.types.is_datetime64_any_dtype(result['timestamp'])

def test_heal_ohlcv_missing_timestamp():
    df = pd.DataFrame({'open': [100, 101]})
    with pytest.raises(ValueError, match="Timestamp column 'timestamp' not found."):
        heal_ohlcv(df)

def test_heal_ohlcv_duplicate_timestamps():
    df = pd.DataFrame({
        'timestamp': ['2024-01-01', '2024-01-01', '2024-01-02'],
        'open': [100, 101, 102],
        'high': [101, 102, 103],
        'low': [99, 100, 101],
        'close': [100.5, 101.5, 102.5],
        'volume': [1000, 1100, 1200]
    })
    result = heal_ohlcv(df)
    assert len(result) == 2
    assert result['timestamp'].iloc[0] == pd.Timestamp('2024-01-01')

def test_heal_ohlcv_unsorted():
    df = pd.DataFrame({
        'timestamp': ['2024-01-03', '2024-01-01', '2024-01-02'],
        'open': [102, 100, 101],
        'high': [103, 101, 102],
        'low': [101, 99, 100],
        'close': [102.5, 100.5, 101.5],
        'volume': [1200, 1000, 1100]
    })
    result = heal_ohlcv(df)
    assert result['timestamp'].iloc[0] == pd.Timestamp('2024-01-01')
    assert result['timestamp'].iloc[1] == pd.Timestamp('2024-01-02')
    assert result['timestamp'].iloc[2] == pd.Timestamp('2024-01-03')

def test_heal_ohlcv_null_handling():
    df = pd.DataFrame({
        'timestamp': ['2024-01-01', '2024-01-02', '2024-01-03'],
        'open': [100, np.nan, 102],
        'high': [101, 102, np.nan],
        'low': [99, 100, 101],
        'close': [100.5, 101.5, 102.5],
        'volume': [1000, 1100, 1200]
    })
    result = heal_ohlcv(df, fill_method='ffill')
    assert not result['open'].isna().any()
    assert result['open'].iloc[1] == 100
