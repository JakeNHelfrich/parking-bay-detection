"""Tests for frame decode helpers and the stub detector."""

from __future__ import annotations

import pytest
from PIL import Image

from app.detection import (
    Detection,
    MalformedFrameError,
    StubDetector,
    decode_jpeg,
    detections_to_wire,
    filter_detections,
)
from tests.conftest import make_jpeg


class TestDecodeJpeg:
    def test_valid_jpeg_decodes(self) -> None:
        image = decode_jpeg(make_jpeg(width=32, height=16))
        assert isinstance(image, Image.Image)
        assert image.size == (32, 16)

    def test_empty_payload_rejected(self) -> None:
        with pytest.raises(MalformedFrameError):
            decode_jpeg(b"")

    def test_garbage_rejected(self) -> None:
        with pytest.raises(MalformedFrameError):
            decode_jpeg(b"this is not an image at all")

    def test_truncated_jpeg_rejected(self) -> None:
        full = make_jpeg()
        with pytest.raises(MalformedFrameError):
            decode_jpeg(full[: len(full) // 2])


class TestStubDetector:
    def test_returns_truck_detections(self) -> None:
        detector = StubDetector()
        detections = detector.infer(Image.new("RGB", (64, 48)), frame_id=0)
        assert len(detections) == 2
        assert all(det.cls == "truck" for det in detections)

    def test_bboxes_are_normalized(self) -> None:
        detector = StubDetector()
        for det in detector.infer(Image.new("RGB", (64, 48)), frame_id=7):
            x, y, w, h = det.bbox
            assert 0.0 <= x <= 1.0
            assert 0.0 <= y <= 1.0
            assert 0.0 <= w <= 1.0
            assert 0.0 <= h <= 1.0
            assert x + w <= 1.0
            assert y + h <= 1.0

    def test_deterministic_per_frame_id(self) -> None:
        detector = StubDetector()
        first = detector.infer(Image.new("RGB", (8, 8)), frame_id=42)
        second = detector.infer(Image.new("RGB", (8, 8)), frame_id=42)
        assert first == second

    def test_parked_truck_stable_drive_truck_moves(self) -> None:
        detector = StubDetector()
        at_0 = detector.infer(Image.new("RGB", (8, 8)), frame_id=0)
        at_45 = detector.infer(Image.new("RGB", (8, 8)), frame_id=45)
        # First (parked) truck identical, second (driving) truck moved.
        assert at_0[0].bbox == at_45[0].bbox
        assert at_0[1].bbox != at_45[1].bbox


class TestFiltering:
    def test_class_and_confidence_filter(self) -> None:
        detections = [
            Detection(cls="truck", conf=0.9, bbox=(0.0, 0.0, 0.1, 0.1)),
            Detection(cls="car", conf=0.95, bbox=(0.2, 0.0, 0.1, 0.1)),
            Detection(cls="truck", conf=0.1, bbox=(0.2, 0.0, 0.1, 0.1)),
        ]
        kept = filter_detections(detections, ["truck"], 0.5)
        assert [det.cls for det in kept] == ["truck"]

    def test_wire_shape(self) -> None:
        wire = detections_to_wire([Detection(cls="truck", conf=0.91, bbox=(0.1, 0.2, 0.3, 0.4))])
        assert wire == [{"cls": "truck", "conf": 0.91, "bbox": [0.1, 0.2, 0.3, 0.4]}]
