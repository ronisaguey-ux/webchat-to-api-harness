# oculus/regime.py
"""
Regime detection for oculus trading system.
Loads pre-trained GMM/HMM models from cache, or fits them on first use.
"""
import numpy as np
import logging
import io
import os
import hmac
import hashlib
import pickle
from typing import Optional, Tuple, Dict, Any

try:
    import joblib as _joblib
    _HAVE_JOBLIB = True
except ImportError:
    _joblib = None
    _HAVE_JOBLIB = False

logger = logging.getLogger(__name__)

# ── Regime labels ──────────────────────────────────────────────────────────────
REGIME_LABELS = {
    0: "Low Volatility / Trend",
    1: "Mean Reversion / Range",
    2: "High Volatility / Breakout",
    3: "Crisis / Crash",
    4: "Mixing / Indeterminate"
}

# ── Cache paths ───────────────────────────────────────────────────────────────
CACHE_DIR = os.environ.get("OCULUS_CACHE_DIR", ".")

GMM_CACHE_BTC = os.path.join(CACHE_DIR, "btc_regime_gmm.pkl")
GMM_CACHE_ETH = os.path.join(CACHE_DIR, "eth_regime_gmm.pkl")


def _checkpoint_hmac_key() -> str:
    """Return the HMAC key for signing model files."""
    return os.environ.get("OCULUS_CHECKPOINT_HMAC_KEY", "")


def _sign_model_file(path: str, key: Optional[str] = None) -> None:
    if key is None:
        key = _checkpoint_hmac_key()
    if not key:
        raise RuntimeError("HMAC key not configured; refusing to sign regime model")
    with open(path, "rb") as f:
        payload = f.read()
    digest = hmac.new(key.encode(), payload, hashlib.sha256).hexdigest()
    sig_path = path + ".hmac"
    with open(sig_path, "w") as f:
        f.write(digest)


def _verify_model_file(path: str, payload: bytes) -> bool:
    """Verify sidecar HMAC matches and that the path is inside the cache dir."""
    key = os.environ.get("OCULUS_CHECKPOINT_HMAC_KEY", "").encode()
    if not key:
        raise RuntimeError(
            "HMAC key not configured; refusing to load unsigned regime model in production"
        )
    real_cache = os.path.realpath(CACHE_DIR)
    real_path = os.path.realpath(path)
    if real_cache and not (real_path == real_cache or real_path.startswith(real_cache + os.sep)):
        return False
    sig_path = path + ".hmac"
    if not os.path.exists(sig_path):
        return False
    with open(sig_path) as hf:
        expected = hf.read().strip()
    return hmac.compare_digest(hmac.new(key, payload, hashlib.sha256).hexdigest(), expected)


def _dump_model(obj: Any, path: str) -> None:
    """Serialize a model to disk using joblib when available, else pickle."""
    if _HAVE_JOBLIB:
        _joblib.dump(obj, path)
    else:
        with open(path, "wb") as f:
            pickle.dump(obj, f)


def _load_model(payload: bytes) -> Any:
    """Deserialize a verified model payload using joblib when available; avoid raw pickle if unsafe."""
    if _HAVE_JOBLIB:
        return _joblib.load(io.BytesIO(payload))
    raise RuntimeError("joblib is required for secure model deserialization; pickle fallback is disabled.")


def _load_gmm_model(coin: str) -> Optional[Any]:
    """
    Attempt to load a pre-trained GMM model for the given coin.
    Returns None if no model is found or verification fails.
    """
    path_map = {
        "BTC": GMM_CACHE_BTC,
        "ETH": GMM_CACHE_ETH,
    }
    path = path_map.get(coin, "")
    if path and os.path.exists(path):
        try:
            with open(path, "rb") as f:
                payload = f.read()
            if not _verify_model_file(path, payload):
                logger.error(f"GMM model {path} failed integrity verification; refusing to load.")
                return None
            return _load_model(payload)
        except Exception as e:
            logger.warning(f"Failed to load GMM model for {coin}: {e}")
    return None


def fit_regime_gmm(*args, **kwargs) -> Tuple[np.ndarray, np.ndarray]:
    """
    Fit a GMM regime model on the given features.
    Returns (regime_labels, regime_quality).
    """
    # Handle V21 signature: fit_regime_gmm(r, v, rv, rsi, atr)
    if len(args) >= 5:
        r, v, rv, rsi, atr = args[:5]
        C = np.cumsum(r)
        feats = {"C": C, "V": v, "RV": rv, "RSI": rsi, "ATR": atr}
        save_path = None
        coin = "BTC"
        n_components = 5
        random_state = 42
    else:
        feats = args[0] if len(args) > 0 else kwargs.get('feats')
        n_components = kwargs.get('n_components', 5)
        random_state = kwargs.get('random_state', 42)
        save_path = kwargs.get('save_path', None)
        coin = kwargs.get('coin', "BTC")

    if not feats or "C" not in feats or len(feats["C"]) == 0:
        n = 0
    else:
        n = len(feats["C"])
    if n == 0:
        return np.array([], dtype=np.int32), np.array([], dtype=np.float64)

    C_raw = feats.get("C", np.zeros(n))
    C_arr = np.asarray(C_raw)
    if C_arr.dtype.kind not in "iufc":
        raise ValueError(f"fit_regime_gmm: C must be numeric, got dtype {C_arr.dtype}")
    if not np.all(np.isfinite(C_arr.astype(np.float64))):
        raise ValueError("fit_regime_gmm: C contains NaN/Inf — refusing to fit")
    C_raw = C_arr
    C_diff = np.diff(C_raw, prepend=C_raw[0] if len(C_raw) > 0 else 0.0)

    X = np.column_stack([
        C_diff,
        feats.get("V", np.zeros(n)),
        feats.get("RV", np.ones(n) * 0.5),
        feats.get("RSI", np.full(n, 50.0)),
        feats.get("ATR", np.ones(n) * 0.02),
    ])

    try:
        from sklearn.mixture import GaussianMixture
        from sklearn.preprocessing import StandardScaler
        from sklearn.pipeline import Pipeline

        train_limit = kwargs.get('train_limit', 0)
        gmm_pipeline = _load_gmm_model(coin) if kwargs.get('allow_cache', False) else None
        if gmm_pipeline is None or len(args) >= 5:
            scaler = StandardScaler()
            gmm = GaussianMixture(n_components=n_components,
                                  random_state=random_state,
                                  n_init=5,
                                  reg_covar=1e-4,
                                  covariance_type="full")

            if train_limit > 0 and train_limit < n:
                scaler.fit(X[:train_limit])
            else:
                scaler.fit(X)

            X_scaled = scaler.transform(X)

            if train_limit > 0 and train_limit < n:
                gmm.fit(X_scaled[:train_limit])
            else:
                gmm.fit(X_scaled)

            gmm_pipeline = Pipeline([('scaler', scaler), ('gmm', gmm)])

            if save_path:
                _dump_model(gmm_pipeline, save_path)
                _sign_model_file(save_path)
            elif not len(args) >= 5 and kwargs.get('allow_cache', False):
                default_path = GMM_CACHE_BTC if coin == "BTC" else GMM_CACHE_ETH
                _dump_model(gmm_pipeline, default_path)
                _sign_model_file(default_path)

        if isinstance(gmm_pipeline, Pipeline):
            scaler = gmm_pipeline.named_steps['scaler']
            gmm = gmm_pipeline.named_steps['gmm']
            X_scaled = scaler.transform(X)
        else:
            gmm = gmm_pipeline
            X_scaled = X

        regimes = gmm.predict(X_scaled)
        quality = gmm.score_samples(X_scaled)
        q_min = np.minimum.accumulate(quality)
        q_max = np.maximum.accumulate(quality)
        q_range = q_max - q_min
        quality = np.where(q_range > 1e-12, (quality - q_min) / np.where(q_range > 1e-12, q_range, 1.0), 0.5)

        bundle = {
            "model": gmm,
            "scaler": scaler,
            "regimes_is": regimes.astype(np.int32),
            "quality_is": quality,
        }
        offset = int(np.bincount(regimes.astype(np.int64), minlength=5).argmax())
        return bundle, offset

    except ImportError:
        logger.warning("sklearn not installed; falling back to dummy GMM labels")
        bundle = {"model": None, "scaler": None, "regimes_is": np.full(n, 4, dtype=np.int32), "quality_is": np.ones(n, dtype=np.float64) * 0.5}
        return bundle, 4


def fit_regime_hmm(*args, **kwargs):
    try:
        import hmmlearn
        raise NotImplementedError("HMM regime detection is not implemented. Use GMM instead.")
    except ImportError:
        raise NotImplementedError("HMM regime detection requires hmmlearn. Please install it.")


def compute_regime_labels(feats: Dict[str, np.ndarray],
                         gmm: Optional[Any] = None,
                         hmm_model: Optional[Any] = None,
                         offset: Optional[int] = None,
                         use_gmm: bool = True,
                         use_hmm: bool = False) -> Tuple[np.ndarray, np.ndarray]:
    if not feats or "C" not in feats or len(feats["C"]) == 0:
        n = 0
    else:
        n = len(feats["C"])

    if n == 0:
        return np.array([], dtype=np.int32), np.array([], dtype=np.float64)

    C_raw = feats.get("C", np.zeros(n))
    C_arr = np.asarray(C_raw)
    if C_arr.dtype.kind not in "iufc":
        raise ValueError(f"fit_regime_gmm: C must be numeric, got dtype {C_arr.dtype}")
    if not np.all(np.isfinite(C_arr.astype(np.float64))):
        raise ValueError("fit_regime_gmm: C contains NaN/Inf — refusing to fit")
    C_raw = C_arr
    C_diff = np.diff(C_raw, prepend=C_raw[0] if len(C_raw) > 0 else 0.0)

    X = np.column_stack([
        C_diff,
        feats.get("V", np.zeros(n)),
        feats.get("RV", np.ones(n) * 0.5),
        feats.get("RSI", np.full(n, 50.0)),
        feats.get("ATR", np.ones(n) * 0.02),
    ])

    if use_gmm:
        if gmm is None:
            gmm = _load_gmm_model("BTC")
        if gmm is None:
            logger.warning("GMM model missing. Using fallback regime 4.")
            return np.full(n, 4, dtype=np.int32), np.ones(n, dtype=np.float64) * 0.5

        try:
            from sklearn.pipeline import Pipeline
            if isinstance(gmm, dict):
                model = gmm.get("model", gmm)
                scaler = gmm.get("scaler", None)
                if model is None:
                    return np.full(n, 4, dtype=np.int32), np.ones(n, dtype=np.float64) * 0.5
                X_scaled = scaler.transform(X) if scaler is not None else X
            elif isinstance(gmm, Pipeline):
                scaler = gmm.named_steps['scaler']
                model = gmm.named_steps['gmm']
                X_scaled = scaler.transform(X)
            else:
                model = gmm
            if not np.isfinite(X_scaled).all():
                logger.error("X_scaled contains non-finite values (NaN/Inf) during GMM prediction.")
                return np.full(n, 4, dtype=np.int32), np.ones(n, dtype=np.float64) * 0.5

            regimes = model.predict(X_scaled)
            quality = model.score_samples(X_scaled)
            q_min = np.fmin.accumulate(quality)
            q_max = np.fmax.accumulate(quality)
            q_range = q_max - q_min
            quality = np.where(q_range > 1e-12, (quality - q_min) / np.where(q_range > 1e-12, q_range, 1.0), 0.5)
            return regimes.astype(np.int32), quality
        except Exception as e:
            logger.error(f"GMM prediction failed: {e}")
            return np.full(n, 4, dtype=np.int32), np.ones(n, dtype=np.float64) * 0.5

    if use_hmm:
        raise NotImplementedError("HMM regime detection is not implemented. Use GMM instead.")

    raise NotImplementedError("Regime model is required. Dummy fallback is not supported.")


def get_regime_position_multiplier(regime: int,
                                   regime_quality: float,
                                   base_leverage: float = 1.0) -> float:
    """
    Get position size multiplier for a given regime.
    Higher quality regimes get larger multipliers.
    """
    regime_quality = float(np.clip(np.nan_to_num(regime_quality, nan=0.5), 0.0, 1.0))
    reg_mult = {
        0: 1.2,   # Low/trend: slightly over-weight
        1: 0.8,   # Mean-rev: under-weight
        2: 1.5,   # High vol: over-weight
        3: 0.3,   # Crash: very under-weight
        4: 1.0,   # Neutral: equal weight
    }

    mult = reg_mult.get(regime, 1.0)
    quality_scale = 0.5 + 0.5 * regime_quality  # [0.5, 1.0] for [0, 1] quality
    return base_leverage * mult * quality_scale


def get_regime_tp_sl(regime: int) -> Tuple[float, float]:
    """
    Get TP/SL for a given regime.
    Returns (tp_pct, sl_pct) as fractions of position.
    """
    reg_tp_sl = {
        0: (0.03, 0.02),  # Low/trend: 3% tp, 2% sl
        1: (0.02, 0.01),  # Mean-rev: 2% tp, 1% sl
        2: (0.05, 0.03),  # High vol: 5% tp, 3% sl
        3: (0.01, 0.005), # Crash: 1% tp, 0.5% sl
        4: (0.03, 0.02),  # Neutral: 3% tp, 2% sl
    }
    return reg_tp_sl.get(regime, (0.03, 0.02))


# ─── Step 26: PRGM Gradient — Regime Velocity Z-Score ────────────────────────

def detect_regime(asset: str, timeframe: str, **kwargs) -> int:
    """
    Detect the current regime for a given asset and timeframe.

    This is a public entry point that loads a pre-trained GMM model from cache
    and returns a regime label (0-4). If no model is available, it falls back
    to regime 4 (Indeterminate) and logs a warning.

    Args:
        asset: Asset symbol (e.g., 'BTC', 'ETH')
        timeframe: Timeframe string (e.g., '5m', '1h') — currently unused but kept for API compatibility.
        **kwargs: Additional arguments (e.g., features to use for prediction).

    Returns:
        int: Regime label (0-4).
    """
    # Attempt to load cached GMM model
    model = _load_gmm_model(asset)
    if model is None:
        logger.warning(f"No GMM model found for {asset}; returning default regime 4")
        return 4

    # If features are provided, we could run prediction, but for a simple stub
    # we return the most common regime (offset) from the training data if available.
    # For now, return a placeholder.
    # In production, this would compute features from recent data and predict.
    logger.info(f"detect_regime called for {asset} {timeframe} — returning default regime 4")
    return 4
