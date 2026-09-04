"""WebSocket tests: frame pipeline via the stub detector.

Covers the wire protocol contract: hello negotiation, per-frame text header +
binary JPEG, frameId echo with latency fields, and graceful handling of
malformed input (socket stays open and remains usable).
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.conftest import make_jpeg


def send_hello(socket: Any) -> None:
    socket.send_json({"type": "hello", "captureWidth": 960, "captureHeight": 540})


def send_frame(socket: Any, frame_id: int, jpeg: bytes) -> None:
    socket.send_json({"type": "frame", "frameId": frame_id})
    socket.send_bytes(jpeg)


def read_detections(socket: Any) -> dict[str, Any]:
    message: dict[str, Any] = socket.receive_json()
    assert message["type"] == "detections"
    return message


class TestFramePipeline:
    def test_frame_id_echo_with_latency_fields(self, client: TestClient) -> None:
        with client.websocket_connect("/ws/detect") as ws:
            send_hello(ws)
            send_frame(ws, 412, make_jpeg())
            message = read_detections(ws)
            assert message["frameId"] == 412
            assert isinstance(message["latencyMs"], (int, float))
            assert isinstance(message["inferenceMs"], (int, float))
            assert message["latencyMs"] >= 0
            assert message["inferenceMs"] >= 0

    def test_detections_payload_shape(self, client: TestClient) -> None:
        with client.websocket_connect("/ws/detect") as ws:
            send_hello(ws)
            send_frame(ws, 1, make_jpeg())
            message = read_detections(ws)
            assert len(message["detections"]) == 2
            for det in message["detections"]:
                assert set(det) == {"cls", "conf", "bbox"}
                assert det["cls"] == "truck"
                assert 0.0 <= det["conf"] <= 1.0
                x, y, w, h = det["bbox"]
                assert 0.0 <= x <= 1.0 and 0.0 <= y <= 1.0
                assert 0.0 <= w <= 1.0 and 0.0 <= h <= 1.0

    def test_frame_ids_are_echoed_in_order(self, client: TestClient) -> None:
        with client.websocket_connect("/ws/detect") as ws:
            send_hello(ws)
            for frame_id in (10, 11, 12):
                send_frame(ws, frame_id, make_jpeg())
            for frame_id in (10, 11, 12):
                assert read_detections(ws)["frameId"] == frame_id

    def test_hello_only_session_is_accepted(self, client: TestClient) -> None:
        """hello with no frames: server stays connected and silent."""
        with client.websocket_connect("/ws/detect") as ws:
            send_hello(ws)
            # No exception; nothing to read. Closing is clean.
            ws.close()


class TestMalformedInput:
    def test_undecodable_jpeg_rejected_socket_stays_open(self, client: TestClient) -> None:
        with client.websocket_connect("/ws/detect") as ws:
            send_hello(ws)
            send_frame(ws, 7, b"definitely not a jpeg")
            error: dict[str, str] = ws.receive_json()
            assert error["type"] == "error"
            # Socket must remain usable for the next frame.
            send_frame(ws, 8, make_jpeg())
            assert read_detections(ws)["frameId"] == 8

    def test_binary_without_frame_header_rejected(self, client: TestClient) -> None:
        with client.websocket_connect("/ws/detect") as ws:
            send_hello(ws)
            ws.send_bytes(make_jpeg())
            error: dict[str, str] = ws.receive_json()
            assert error["type"] == "error"
            assert "header" in error["message"]
            # Socket stays open; a proper frame still works.
            send_frame(ws, 21, make_jpeg())
            assert read_detections(ws)["frameId"] == 21

    def test_invalid_json_rejected(self, client: TestClient) -> None:
        with client.websocket_connect("/ws/detect") as ws:
            send_hello(ws)
            ws.send_text("not json at all")
            assert ws.receive_json()["type"] == "error"
            send_frame(ws, 5, make_jpeg())
            assert read_detections(ws)["frameId"] == 5

    def test_non_object_json_rejected(self, client: TestClient) -> None:
        with client.websocket_connect("/ws/detect") as ws:
            send_hello(ws)
            ws.send_json([1, 2, 3])
            assert ws.receive_json()["type"] == "error"
            send_frame(ws, 6, make_jpeg())
            assert read_detections(ws)["frameId"] == 6

    def test_unknown_message_type_rejected(self, client: TestClient) -> None:
        with client.websocket_connect("/ws/detect") as ws:
            send_hello(ws)
            ws.send_json({"type": "mystery"})
            assert ws.receive_json()["type"] == "error"
            send_frame(ws, 9, make_jpeg())
            assert read_detections(ws)["frameId"] == 9

    def test_frame_header_with_bad_frame_id_rejected(self, client: TestClient) -> None:
        with client.websocket_connect("/ws/detect") as ws:
            send_hello(ws)
            ws.send_json({"type": "frame", "frameId": -1})
            assert ws.receive_json()["type"] == "error"
            # The bad header must not poison the next valid frame.
            send_frame(ws, 13, make_jpeg())
            assert read_detections(ws)["frameId"] == 13

    def test_invalid_hello_rejected(self, client: TestClient) -> None:
        with client.websocket_connect("/ws/detect") as ws:
            ws.send_json({"type": "hello", "captureWidth": 0, "captureHeight": 540})
            assert ws.receive_json()["type"] == "error"
            # A valid hello after a bad one still works.
            send_hello(ws)
            send_frame(ws, 2, make_jpeg())
            assert read_detections(ws)["frameId"] == 2
