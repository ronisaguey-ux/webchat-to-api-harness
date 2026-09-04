import pytest
import pandas as pd
import numpy as np
from oculus.data_validation import DataManifest, validate_historical_data


def test_manifest_valid():
    manifest = DataManifest({
        "schema": {"price": "float64", "volume": "int64"},
        "required_columns": ["price", "volume"],
        "nullable": {"price": False},
        "min_rows": 1,
        "max_rows": 10
    })
    df = pd.DataFrame({"price": [1.0, 2.0], "volume": [100, 200]})
    errors = manifest.validate_dataframe(df)
    assert errors == []


def test_manifest_missing_column():
    manifest = DataManifest({
        "required_columns": ["price", "volume"],
    })
    df = pd.DataFrame({"price": [1.0, 2.0]})
    errors = manifest.validate_dataframe(df)
    assert any("Required column 'volume' missing" in e for e in errors)


def test_manifest_schema_mismatch():
    manifest = DataManifest({
        "schema": {"price": "float64"},
    })
    df = pd.DataFrame({"price": [1, 2]})  # int64
    errors = manifest.validate_dataframe(df)
    assert any("expected dtype float64" in e for e in errors)


def test_manifest_nullable():
    manifest = DataManifest({
        "nullable": {"price": False},
    })
    df = pd.DataFrame({"price": [1.0, np.nan]})
    errors = manifest.validate_dataframe(df)
    assert any("contains nulls but is marked non-nullable" in e for e in errors)


def test_validate_historical_data_passes():
    manifest = DataManifest({
        "required_columns": ["price"],
        "min_rows": 1
    })
    df = pd.DataFrame({"price": [1.0, 2.0]})
    result = validate_historical_data(df, manifest)
    assert result is True


def test_validate_historical_data_fails():
    manifest = DataManifest({
        "required_columns": ["price"],
    })
    df = pd.DataFrame({"volume": [1.0, 2.0]})
    with pytest.raises(ValueError, match="Data validation failed"):
        validate_historical_data(df, manifest)
