"""Tests for the real YOLO backend — all via an injected fake model factory.

Per AGENTS.md, tests must not require the real YOLO weights or network access:
the ultralytics constructor is replaced by ``model_factory``, and results are
synthetic objects shaped like Ultralytics results (``.boxes.xyxy/conf/cls``
with ``.tolist()``, ``.names`` id→name mapping).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from types import SimpleNamespace

import pytest
from PIL import Image

from app.detection import ModelLoadError, YoloDetector, create_detector


@dataclass
class FakeTensor:
    values: list[object]

    def tolist(self) -> list[object]:
        return list(self.values)


@dataclass
class FakeBoxes:
    xyxy: FakeTensor
    conf: FakeTensor
    cls: FakeTensor


@dataclass
class FakeResult:
    boxes: FakeBoxes
    names: dict[int, str] = field(default_factory=dict)


class FakeModel:
    """Stands in for ``ultralytics.YOLO``; records predict kwargs."""

    def __init__(self, model_name: str) -> None:
        self.model_name = model_name
        self.calls: list[dict[str, object]] = []
        self.result: FakeResult | None = None

    def predict(
        self,
        source: object,
        conf: float,
        classes: list[int],
        verbose: bool,
        **extra: object,
    ) -> list[FakeResult]:
        call: dict[str, object] = {
            "source": source,
            "conf": conf,
            "classes": classes,
            "verbose": verbose,
            **extra,
        }
        self.calls.append(call)
        assert self.result is not None, "test must set .result before predict"
        return [self.result]


class ExplodingFactory:
    def __init__(self, exc: Exception) -> None:
        self._exc = exc

    def __call__(self, model_name: str) -> object:
        raise self._exc


def make_detector(
    result: FakeResult | None = None,
    model_name: str = "yolov8n.pt",
    allowed_classes: list[str] | None = None,
    confidence_threshold: float = 0.35,
    imgsz: int | None = None,
    model_factory: Callable[[str], object] | None = None,
) -> tuple[YoloDetector, FakeModel]:
    if model_factory is None:
        fake = FakeModel(model_name)
        fake.result = (
            result
            if result is not None
            else FakeResult(
                boxes=FakeBoxes(FakeTensor([]), FakeTensor([]), FakeTensor([])),
                names={7: "truck"},
            )
        )
        detector = YoloDetector(
            model_name=model_name,
            allowed_classes=allowed_classes,
            confidence_threshold=confidence_threshold,
            imgsz=imgsz,
            model_factory=lambda _name: fake,
        )
        return detector, fake
    detector = YoloDetector(
        model_name=model_name,
        allowed_classes=allowed_classes,
        confidence_threshold=confidence_threshold,
        model_factory=model_factory,
    )
    return detector, FakeModel(model_name)  # second value unused in this path


class TestLazyLoading:
    def test_construction_does_not_load_weights(self) -> None:
        loads = 0

        def factory(name: str) -> object:
            nonlocal loads
            loads += 1
            return FakeModel(name)

        detector, _ = make_detector(model_factory=factory)
        assert loads == 0  # cheap construction; no weights, no ultralytics import
        detector.ensure_loaded()
        assert loads == 1

    def test_model_loads_exactly_once(self) -> None:
        loads = 0
        fake = FakeModel("yolov8n.pt")
        fake.result = FakeResult(boxes=FakeBoxes(FakeTensor([]), FakeTensor([]), FakeTensor([])))

        def counting_factory(name: str) -> object:
            nonlocal loads
            loads += 1
            return fake

        detector = YoloDetector(model_factory=counting_factory)
        image = Image.new("RGB", (64, 48))
        detector.infer(image, frame_id=1)
        detector.infer(image, frame_id=2)
        detector.ensure_loaded()
        assert loads == 1  # exactly one model construction across all uses

    def test_load_failure_raises_model_load_error(self) -> None:
        detector, _ = make_detector(model_factory=ExplodingFactory(RuntimeError("weights missing")))
        with pytest.raises(ModelLoadError, match="weights missing"):
            detector.ensure_loaded()


class TestClassResolution:
    def test_truck_resolves_to_coco_id_7(self) -> None:
        detector, fake = make_detector(allowed_classes=["truck"])
        image = Image.new("RGB", (64, 48))
        detector.infer(image)
        assert fake.calls[0]["classes"] == [7]

    def test_multiple_allowed_classes_sorted(self) -> None:
        detector, fake = make_detector(allowed_classes=["truck", "car", "bus"])
        image = Image.new("RGB", (64, 48))
        detector.infer(image)
        assert fake.calls[0]["classes"] == [2, 5, 7]

    def test_unknown_class_rejected_at_construction(self) -> None:
        with pytest.raises(ModelLoadError, match="not in COCO-80"):
            make_detector(allowed_classes=["semi-truck-lore"])


class TestInferenceMapping:
    def test_xyxy_pixels_map_to_normalized_xywh_topleft(self) -> None:
        # 100x50 image; box (10, 10)-(30, 30) → normalized xywh.
        result = FakeResult(
            boxes=FakeBoxes(
                xyxy=FakeTensor([[10.0, 10.0, 30.0, 30.0]]),
                conf=FakeTensor([0.87]),
                cls=FakeTensor([7.0]),
            ),
            names={7: "truck"},
        )
        detector, _ = make_detector(result=result)
        detections = detector.infer(Image.new("RGB", (100, 50)))
        assert len(detections) == 1
        det = detections[0]
        assert det.cls == "truck"
        assert det.conf == pytest.approx(0.87)
        x, y, w, h = det.bbox
        assert x == pytest.approx(0.10)
        assert y == pytest.approx(0.20)
        assert w == pytest.approx(0.20)
        assert h == pytest.approx(0.40)

    def test_boxes_clipped_into_unit_square(self) -> None:
        result = FakeResult(
            boxes=FakeBoxes(
                xyxy=FakeTensor([[-10.0, -5.0, 120.0, 80.0]]),
                conf=FakeTensor([0.9]),
                cls=FakeTensor([7.0]),
            ),
            names={7: "truck"},
        )
        detector, _ = make_detector(result=result)
        (det,) = detector.infer(Image.new("RGB", (100, 50)))
        x, y, w, h = det.bbox
        assert x == 0.0
        assert y == 0.0
        assert x + w == pytest.approx(1.0)
        assert y + h == pytest.approx(1.0)

    def test_no_boxes_gives_empty_list(self) -> None:
        detector, _ = make_detector()
        assert detector.infer(Image.new("RGB", (64, 48))) == []

    def test_predict_receives_confidence_threshold(self) -> None:
        detector, fake = make_detector(confidence_threshold=0.55)
        detector.infer(Image.new("RGB", (64, 48)))
        assert fake.calls[0]["conf"] == 0.55

    def test_predict_receives_imgsz_when_set(self) -> None:
        detector, fake = make_detector(imgsz=960)
        detector.infer(Image.new("RGB", (64, 48)))
        assert fake.calls[0]["imgsz"] == 960

    def test_predict_omits_imgsz_by_default(self) -> None:
        """Unset imgsz must fall through to the model default, not None."""
        detector, fake = make_detector()
        detector.infer(Image.new("RGB", (64, 48)))
        assert "imgsz" not in fake.calls[0]


class TestCreateDetectorYolo:
    def test_yolo_settings_build_lazy_detector(self) -> None:
        settings = SimpleNamespace(
            detector="yolo",
            model_name="",
            allowed_classes=["truck"],
            confidence_threshold=0.4,
        )
        detector = create_detector(settings)
        assert isinstance(detector, YoloDetector)
        assert detector.model_label == "yolov8n.pt"  # default kicks in when unset
        # Construction is cheap: no model was loaded by the factory.
        detector.ensure_loaded()  # would raise only if the default factory ran

    def test_yolo_settings_pass_imgsz_through(self) -> None:
        settings = SimpleNamespace(
            detector="yolo",
            model_name="",
            allowed_classes=["truck"],
            confidence_threshold=0.4,
            imgsz=960,
        )
        detector = create_detector(settings)
        assert isinstance(detector, YoloDetector)
        assert detector._imgsz == 960

    def test_yolo_custom_model_name_preserved(self) -> None:
        settings = SimpleNamespace(
            detector="yolo",
            model_name="/models/fine-tuned.pt",
            allowed_classes=["truck"],
            confidence_threshold=0.4,
        )
        detector = create_detector(settings)
        assert isinstance(detector, YoloDetector)
        assert detector.model_label == "/models/fine-tuned.pt"

    def test_yolo_unknown_class_surfaces_as_model_load_error(self) -> None:
        settings = SimpleNamespace(
            detector="yolo",
            model_name="",
            allowed_classes=["pickup-truck"],
            confidence_threshold=0.4,
        )
        with pytest.raises(ModelLoadError):
            create_detector(settings)
