"""Detection layer: frame decoding and the detector interface.

Invariants enforced here (see AGENTS.md):

- Frame decoding happens in exactly one place: :func:`decode_jpeg`. Route and
  WebSocket logic never touch raw pixel data.
- All bboxes produced by detectors are ``[x, y, w, h]`` normalized to ``0..1``
  with a top-left origin, matching the wire protocol.
"""

from __future__ import annotations

import io
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

from PIL import Image, UnidentifiedImageError


class MalformedFrameError(ValueError):
    """Raised when a binary payload is not a decodable image."""


class ModelLoadError(RuntimeError):
    """Raised when a detector backend cannot be initialized."""


@dataclass(frozen=True)
class Detection:
    """A single detected object in normalized frame coordinates."""

    cls: str
    conf: float
    # [x, y, w, h] in 0..1, origin top-left.
    bbox: tuple[float, float, float, float]


def decode_jpeg(payload: bytes) -> Image.Image:
    """Decode a JPEG payload into a PIL image.

    This is the ONLY place in the service that touches frame bytes. Raises
    :class:`MalformedFrameError` for anything that is not a decodable image.
    """
    if not payload:
        raise MalformedFrameError("empty frame payload")
    try:
        image = Image.open(io.BytesIO(payload))
        image.load()
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise MalformedFrameError(f"undecodable frame: {exc}") from exc
    return image


class Detector(Protocol):
    """Anything that can turn a decoded frame into detections."""

    def infer(self, image: Image.Image, frame_id: int = 0) -> list[Detection]:
        """Run inference on a decoded frame.

        ``frame_id`` lets stateful stub detectors produce deterministic,
        deterministic-per-frame output; real model backends ignore it.
        """
        ...


class StubDetector:
    """Canned, deterministic detector used until the real model lands (M4).

    Produces one truck permanently parked plus one truck driving across the
    frame, so the frontend overlay has both a stable and a moving box to draw.
    Positions are functions of ``frame_id`` only — no randomness, no clock —
    which keeps tests reproducible.
    """

    DRIVE_LOOP_FRAMES = 90

    def __init__(self, confidence_threshold: float = 0.35) -> None:
        self._confidence_threshold = confidence_threshold

    def infer(self, image: Image.Image, frame_id: int = 0) -> list[Detection]:
        del image  # The stub never looks at pixels.
        detections = [
            Detection(
                cls="truck",
                conf=0.91,
                bbox=(0.10, 0.55, 0.14, 0.10),
            )
        ]
        # Driving truck sweeps left → right, then wraps around.
        phase = (max(frame_id, 0) % self.DRIVE_LOOP_FRAMES) / self.DRIVE_LOOP_FRAMES
        drive_x = 0.05 + phase * 0.80
        detections.append(
            Detection(
                cls="truck",
                conf=0.88,
                bbox=(drive_x, 0.30, 0.16, 0.11),
            )
        )
        return [det for det in detections if det.conf >= self._confidence_threshold]


def create_detector(settings: object) -> Detector:
    """Factory for the configured detector backend.

    Takes an opaque settings object (duck-typed to avoid a circular import)
    and returns a ready-to-use detector. Raises :class:`ModelLoadError` if the
    requested backend cannot be initialized — callers surface this as a 503 on
    ``/health`` rather than crashing.
    """
    detector_kind = getattr(settings, "detector", "stub")
    confidence_threshold = getattr(settings, "confidence_threshold", 0.35)

    if detector_kind == "stub":
        return StubDetector(confidence_threshold=confidence_threshold)

    if detector_kind == "yolo":
        # Real backend lands in M4; until then, selecting it is an explicit
        # configuration error rather than a silent fallback to the stub.
        raise ModelLoadError(
            "detector='yolo' is not implemented yet (planned for M4); set PARKING_DETECTOR=stub"
        )

    raise ModelLoadError(f"unknown detector kind: {detector_kind!r}")


def filter_detections(
    detections: list[Detection],
    allowed_classes: list[str],
    confidence_threshold: float,
) -> list[Detection]:
    """Apply class + confidence filtering (used by real backends and tests)."""
    allowed = set(allowed_classes)
    return [det for det in detections if det.cls in allowed and det.conf >= confidence_threshold]


def detections_to_wire(detections: list[Detection]) -> list[dict[str, object]]:
    """Serialize detections into the wire-protocol dict shape."""
    return [
        {"cls": det.cls, "conf": round(det.conf, 4), "bbox": list(det.bbox)} for det in detections
    ]


# Convenience alias for type-annotating detector factories.
DetectorFactory = Callable[[], Detector]
