"""Runtime configuration for the detection service.

All knobs are overridable via environment variables so deployment can tune
inference without code changes. Defaults are aimed at local development with
the stub detector; select the real model with ``PARKING_DETECTOR=yolo``
(requires the ``model`` extra).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _env_str(key: str, default: str) -> str:
    return os.environ.get(key, default)


def _env_float(key: str, default: float) -> float:
    raw = os.environ.get(key)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_int(key: str, default: int) -> int:
    raw = os.environ.get(key)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_optional_int(key: str, default: int | None) -> int | None:
    raw = os.environ.get(key)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_str_list(key: str, default: list[str]) -> list[str]:
    raw = os.environ.get(key)
    if raw is None or not raw.strip():
        return default
    return [item.strip() for item in raw.split(",") if item.strip()]


@dataclass(frozen=True)
class Settings:
    """Immutable service configuration."""

    # "stub" returns canned boxes (no weights needed); "yolo" runs the real
    # model (requires the `model` extra).
    detector: str = field(default_factory=lambda: _env_str("PARKING_DETECTOR", "stub"))
    # Model name for the YOLO backend (e.g. "yolov8n.pt" or a path to custom
    # weights). Empty means "the backend's default"; whatever serves is
    # surfaced via /health so the frontend HUD can display it.
    model_name: str = field(default_factory=lambda: _env_str("PARKING_MODEL_NAME", ""))
    # NOTE (measured 2026-09-05, simtruck.pt over 503 GT frames): 0.35 is
    # optimal at the bay-occupancy level — all observed noise detections
    # (conf ≤ 0.67) sit away from bays (0 occupancy FPs), while raising the
    # threshold only creates false-empty bays (real trucks down to conf
    # 0.43). Do not raise without re-measuring; see README "Threshold
    # tuning measurements".
    confidence_threshold: float = field(
        default_factory=lambda: _env_float("PARKING_CONF_THRESHOLD", 0.35)
    )
    allowed_classes: list[str] = field(
        default_factory=lambda: _env_str_list("PARKING_ALLOWED_CLASSES", ["truck"])
    )
    # Inference input size (longest edge, pixels) for the YOLO backend, e.g.
    # 960. None uses the model default. Larger values help with small objects
    # (like trucks seen from far away) at a latency cost — see the README
    # benchmark table before changing.
    imgsz: int | None = field(default_factory=lambda: _env_optional_int("PARKING_IMGSZ", None))
    host: str = field(default_factory=lambda: _env_str("PARKING_HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: _env_int("PARKING_PORT", 8000))
    # Directory containing the built frontend (frontend/dist) to serve at "/".
    # Single-container deploys bake the build in here; empty/missing dir means
    # "not served" (local dev uses the Vite dev server instead).
    static_dir: str = field(default_factory=lambda: _env_str("PARKING_STATIC_DIR", "static"))


def load_settings() -> Settings:
    """Build settings from the environment (kept as a function for tests)."""
    return Settings()
