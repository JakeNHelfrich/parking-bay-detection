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
    """Canned, deterministic detector; default backend for tests and dev.

    Produces one truck permanently parked plus one truck driving across the
    frame, so the frontend overlay has both a stable and a moving box to draw.
    Positions are functions of ``frame_id`` only — no randomness, no clock —
    which keeps tests reproducible.

    The canned boxes are screen-space projections of the simulated scene for
    the default camera (fov 55, eye (-22, 24, 30), target (0, 0, -2)) at a
    16:9 view — the same projection that generated ``bays.json`` — so boxes
    visually align with the rendered trucks:

    - parked truck: standing at bay 0 (world x=-6.9, z=-4.8, nose toward lane)
    - driving truck: sweeping along the lane from world x=-30 to x=+40;
      position and size lerp between the projected endpoint rects (the true
      path curves slightly under perspective, close enough for a stub)
    """

    DRIVE_LOOP_FRAMES = 90
    model_label = "stub"

    # Projected bbox of a truck parked at bay 0: [x, y, w, h], normalized.
    PARKED_BBOX = (0.3857, 0.4562, 0.0499, 0.0924)
    # Projected endpoint rects of the lane sweep (world x=-30 and x=+40).
    DRIVE_START = (0.0011, 0.7218, 0.1209, 0.153)
    DRIVE_END = (0.7708, 0.2942, 0.0431, 0.0512)

    def __init__(self, confidence_threshold: float = 0.35) -> None:
        self._confidence_threshold = confidence_threshold

    def infer(self, image: Image.Image, frame_id: int = 0) -> list[Detection]:
        del image  # The stub never looks at pixels.
        detections = [
            Detection(cls="truck", conf=0.91, bbox=self.PARKED_BBOX)
        ]
        # Driving truck sweeps along the lane, left-front → right-far, then
        # wraps around. Position and size lerp between the projected
        # endpoint rects; the perspective path curves slightly, ignored here.
        phase = (max(frame_id, 0) % self.DRIVE_LOOP_FRAMES) / self.DRIVE_LOOP_FRAMES
        bbox = tuple(
            start + (end - start) * phase
            for start, end in zip(self.DRIVE_START, self.DRIVE_END, strict=True)
        )
        detections.append(
            Detection(
                cls="truck",
                conf=0.88,
                bbox=bbox,
            )
        )
        return [det for det in detections if det.conf >= self._confidence_threshold]


# COCO-80 class index → name. Used to resolve ``allowed_classes`` (given as
# names, e.g. "truck") to model class ids without needing the weights loaded.
COCO_CLASS_NAMES: tuple[str, ...] = (
    "person",
    "bicycle",
    "car",
    "motorcycle",
    "airplane",
    "bus",
    "train",
    "truck",
    "boat",
    "traffic light",
    "fire hydrant",
    "stop sign",
    "parking meter",
    "bench",
    "bird",
    "cat",
    "dog",
    "horse",
    "sheep",
    "cow",
    "elephant",
    "bear",
    "zebra",
    "giraffe",
    "backpack",
    "umbrella",
    "handbag",
    "tie",
    "suitcase",
    "frisbee",
    "skis",
    "snowboard",
    "sports ball",
    "kite",
    "baseball bat",
    "baseball glove",
    "skateboard",
    "surfboard",
    "tennis racket",
    "bottle",
    "wine glass",
    "cup",
    "fork",
    "knife",
    "spoon",
    "bowl",
    "banana",
    "apple",
    "sandwich",
    "orange",
    "broccoli",
    "carrot",
    "hot dog",
    "pizza",
    "donut",
    "cake",
    "chair",
    "couch",
    "potted plant",
    "bed",
    "dining table",
    "toilet",
    "tv",
    "laptop",
    "mouse",
    "remote",
    "keyboard",
    "cell phone",
    "microwave",
    "oven",
    "toaster",
    "sink",
    "refrigerator",
    "book",
    "clock",
    "vase",
    "scissors",
    "teddy bear",
    "hair drier",
    "toothbrush",
)


class YoloDetector:
    """Real YOLO backend (Ultralytics), loaded lazily exactly once.

    - The heavy ``ultralytics`` import and weight load happen on first use —
      never per connection, never per frame. ``ensure_loaded`` lets the app
      lifespan force the load at startup so failures surface on ``/health``.
    - ``allowed_classes`` are COCO names (default ``["truck"]`` = class 7);
      they are resolved to class ids up front, without the model.
    - Results are normalized to ``[x, y, w, h]`` in 0..1, top-left origin —
      Ultralytics pixel boxes already use a top-left origin, so this is a
      straight division by frame size, no flip.
    - ``model_factory`` is an injection seam for tests: it stands in for the
      ``ultralytics.YOLO`` constructor so tests never need weights or network.
    """

    DEFAULT_MODEL = "yolov8n.pt"

    def __init__(
        self,
        model_name: str = DEFAULT_MODEL,
        allowed_classes: list[str] | None = None,
        confidence_threshold: float = 0.35,
        model_factory: Callable[[str], object] | None = None,
    ) -> None:
        self.model_label = model_name
        self._model_name = model_name
        self._confidence_threshold = confidence_threshold
        self._model_factory = model_factory
        self._model: object | None = None

        classes = allowed_classes if allowed_classes is not None else ["truck"]
        name_to_id = {name: idx for idx, name in enumerate(COCO_CLASS_NAMES)}
        unknown = [cls for cls in classes if cls not in name_to_id]
        if unknown:
            raise ModelLoadError(f"allowed_classes not in COCO-80: {unknown!r}")
        self._class_ids = sorted({name_to_id[cls] for cls in classes})

    def ensure_loaded(self) -> None:
        """Force the lazy weight load; raises ModelLoadError on failure."""
        self._ensure_model()

    def _ensure_model(self) -> object:
        if self._model is None:
            try:
                # Deferred heavy import: base installs (tests, stub mode) never
                # need ultralytics/torch. Ignored here and re-raised below.
                from ultralytics import YOLO  # noqa: PLC0415

                factory = self._model_factory if self._model_factory is not None else YOLO
                self._model = factory(self._model_name)
            except Exception as exc:
                if isinstance(exc, ModelLoadError):
                    raise
                raise ModelLoadError(
                    f"failed to load YOLO model {self._model_name!r}: {exc}"
                ) from exc
        return self._model

    def infer(self, image: Image.Image, frame_id: int = 0) -> list[Detection]:
        del frame_id  # stateless backend; frame_id is only meaningful to stubs
        model = self._ensure_model()
        results = model.predict(  # type: ignore[attr-defined]
            source=image,
            conf=self._confidence_threshold,
            classes=self._class_ids,
            verbose=False,
        )
        return _result_to_detections(results[0], image.size)


def _result_to_detections(
    result: object,
    image_size: tuple[int, int],
) -> list[Detection]:
    """Convert one Ultralytics result to normalized wire Detections.

    Ultralytics gives pixel ``xyxy`` boxes with a top-left origin — the same
    convention as the wire protocol — so normalization is a straight divide by
    frame width/height with clipping into 0..1. No y-flip.
    """
    boxes = getattr(result, "boxes", None)
    if boxes is None:
        return []
    width, height = image_size
    if width <= 0 or height <= 0:
        return []
    xyxy_list = boxes.xyxy.tolist()
    conf_list = boxes.conf.tolist()
    cls_list = boxes.cls.tolist()
    names: dict[int, str] = dict(getattr(result, "names", {}))
    detections: list[Detection] = []
    for xyxy, conf, cls_id in zip(xyxy_list, conf_list, cls_list, strict=True):
        x1, y1, x2, y2 = (float(v) for v in xyxy)
        nx1, ny1 = max(x1, 0.0) / width, max(y1, 0.0) / height
        nx2, ny2 = min(x2, width) / width, min(y2, height) / height
        detections.append(
            Detection(
                cls=names.get(int(cls_id), str(int(cls_id))),
                conf=float(conf),
                bbox=(nx1, ny1, max(nx2 - nx1, 0.0), max(ny2 - ny1, 0.0)),
            )
        )
    return detections


def create_detector(settings: object) -> Detector:
    """Factory for the configured detector backend.

    Takes an opaque settings object (duck-typed to avoid a circular import)
    and returns a ready-to-use detector. Raises :class:`ModelLoadError` if the
    requested backend cannot be initialized — callers surface this as a 503 on
    ``/health`` rather than crashing.

    The YOLO backend is *lazily* loaded: constructing it is cheap (no weights,
    no torch import); the model loads exactly once on first use (or when the
    app lifespan calls ``ensure_loaded`` at startup, which is how load
    failures surface on ``/health``).
    """
    detector_kind = getattr(settings, "detector", "stub")
    confidence_threshold = getattr(settings, "confidence_threshold", 0.35)

    if detector_kind == "stub":
        return StubDetector(confidence_threshold=confidence_threshold)

    if detector_kind == "yolo":
        model_name = str(getattr(settings, "model_name", "") or YoloDetector.DEFAULT_MODEL)
        allowed_classes = list(getattr(settings, "allowed_classes", ["truck"]))
        try:
            return YoloDetector(
                model_name=model_name,
                allowed_classes=allowed_classes,
                confidence_threshold=confidence_threshold,
            )
        except ModelLoadError:
            raise

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
