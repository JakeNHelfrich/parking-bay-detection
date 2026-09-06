"""WebSocket tests: frame pipeline via the stub detector.

Covers the wire protocol contract: hello negotiation, per-frame text header +
binary JPEG, frameId echo with latency fields, and graceful handling of
malformed input (socket stays open and remains usable).
"""

from __future__ import annotations

import time
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.main import app
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
        """When the client keeps pace (send → read), every frame gets a reply."""
        with client.websocket_connect("/ws/detect") as ws:
            send_hello(ws)
            for frame_id in (10, 11, 12):
                send_frame(ws, frame_id, make_jpeg())
                assert read_detections(ws)["frameId"] == frame_id

    def test_backlog_coalesces_to_latest_frame(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Under load, superseded frames are skipped; the newest always wins.

        A deliberately slow detector makes the interleaving deterministic:
        frames 11/12 arrive while frame 10 is mid-inference, so at most frame
        10 and the final frame 12 are answered — never 11, and 12 is last.
        """

        class SlowDetector:
            model_label = "slow-stub"

            def infer(self, image: object, frame_id: int = 0) -> list[object]:
                del image
                time.sleep(0.15)
                return []

        monkeypatch.setattr(app.state, "detector", SlowDetector())
        with client.websocket_connect("/ws/detect") as ws:
            send_hello(ws)
            send_frame(ws, 10, make_jpeg())
            time.sleep(0.05)  # let frame 10 start inference
            send_frame(ws, 11, make_jpeg())
            send_frame(ws, 12, make_jpeg())
            replies = [read_detections(ws)]
            while replies[-1]["frameId"] != 12:
                replies.append(read_detections(ws))
            ids = [message["frameId"] for message in replies]
            assert ids[-1] == 12
            assert ids == sorted(set(ids))  # in-order, no duplicates
            assert len(ids) <= 2  # superseded frames were skipped
            # Socket remains usable after the backlog.
            send_frame(ws, 13, make_jpeg())
            assert read_detections(ws)["frameId"] == 13

    def test_hello_only_session_is_accepted(self, client: TestClient) -> None:
        """hello with no frames: server stays connected and silent."""
        with client.websocket_connect("/ws/detect") as ws:
            send_hello(ws)
            # No exception; nothing to read. Closing is clean.
            ws.close()


class TestBayState:
    """bayState batches: frontend-reported confirmed transitions (rzo.1).

    The server never derives bay state (invariant 5) — it validates the
    batch shape and acknowledges it, echoing the batch's frameId.
    """

    @staticmethod
    def send_batch(socket: Any, frame_id: int, events: list[dict[str, Any]]) -> None:
        socket.send_json({"type": "bayState", "frameId": frame_id, "events": events})

    def test_valid_batch_is_acked_with_frame_id_echo(self, client: TestClient) -> None:
        with client.websocket_connect("/ws/detect") as ws:
            hello_with_map_version(ws, "map-hash-a")
            self.send_batch(
                ws,
                412,
                [
                    {"bayId": 0, "occupied": True, "confidence": 0.87},
                    {"bayId": 2, "occupied": False},
                ],
            )
            ack: dict[str, Any] = ws.receive_json()
            assert ack == {"type": "bayStateAck", "frameId": 412, "accepted": 2}
            # Socket remains fully usable for frames afterwards.
            send_frame(ws, 413, make_jpeg())
            assert read_detections(ws)["frameId"] == 413

    def test_int_confidence_is_accepted(self, client: TestClient) -> None:
        with client.websocket_connect("/ws/detect") as ws:
            hello_with_map_version(ws, "map-hash-a")
            self.send_batch(ws, 1, [{"bayId": 3, "occupied": True, "confidence": 1}])
            assert ws.receive_json()["accepted"] == 1

    @pytest.mark.parametrize(
        ("frame_id", "events"),
        [
            (-1, [{"bayId": 0, "occupied": True}]),
            ("412", [{"bayId": 0, "occupied": True}]),
            (412, []),
            (412, "nope"),
            (412, ["not an object"]),
            (412, [{"occupied": True}]),
            (412, [{"bayId": -1, "occupied": True}]),
            (412, [{"bayId": 0, "occupied": "yes"}]),
            (412, [{"bayId": 0, "occupied": True, "confidence": 1.5}]),
            (412, [{"bayId": 0, "occupied": True, "confidence": "high"}]),
            (412, [{"bayId": 0, "occupied": True}, {"bayId": 0, "occupied": False}]),
        ],
    )
    def test_invalid_batch_rejected_socket_stays_open(
        self, client: TestClient, frame_id: Any, events: Any
    ) -> None:
        with client.websocket_connect("/ws/detect") as ws:
            send_hello(ws)
            self.send_batch(ws, frame_id, events)
            error: dict[str, str] = ws.receive_json()
            assert error["type"] == "error"
            # The bad batch must not poison the connection.
            send_frame(ws, 9, make_jpeg())
            assert read_detections(ws)["frameId"] == 9

    def test_ack_does_not_settle_a_pending_frame(self, client: TestClient) -> None:
        """A bayState ack mid-flight must not be treated as a frame reply."""
        with client.websocket_connect("/ws/detect") as ws:
            hello_with_map_version(ws, "map-hash-a")
            send_frame(ws, 20, make_jpeg())
            self.send_batch(ws, 999, [{"bayId": 1, "occupied": True}])
            first: dict[str, Any] = ws.receive_json()
            second: dict[str, Any] = ws.receive_json()
            replies = {first["type"], second["type"]}
            assert replies == {"detections", "bayStateAck"}
            ack = first if first["type"] == "bayStateAck" else second
            assert ack["frameId"] == 999  # echoes the batch, not the frame


def hello_with_map_version(socket: Any, map_version: str) -> None:
    socket.send_json(
        {"type": "hello", "captureWidth": 960, "captureHeight": 540, "bayMapVersion": map_version}
    )


class TestBayStateRecording:
    """Durable record (bead rzo.2): validated batches land in SQLite."""

    def test_valid_batch_is_persisted_with_map_version(self, db_client: TestClient) -> None:
        recorder = db_client.app.state.recorder
        with db_client.websocket_connect("/ws/detect") as ws:
            hello_with_map_version(ws, "map-hash-a")
            TestBayState.send_batch(ws, 10, [{"bayId": 0, "occupied": True, "confidence": 0.8}])
            assert ws.receive_json()["type"] == "bayStateAck"
        rows = recorder.intervals()
        assert len(rows) == 1
        assert rows[0].bay_id == 0
        assert rows[0].map_version == "map-hash-a"
        assert rows[0].open_frame_id == 10
        assert rows[0].until is None

    def test_close_report_persists_across_batches(self, db_client: TestClient) -> None:
        recorder = db_client.app.state.recorder
        with db_client.websocket_connect("/ws/detect") as ws:
            hello_with_map_version(ws, "map-hash-a")
            TestBayState.send_batch(ws, 1, [{"bayId": 2, "occupied": True}])
            ws.receive_json()
            TestBayState.send_batch(ws, 5, [{"bayId": 2, "occupied": False}])
            ws.receive_json()
        [row] = recorder.intervals(bay_id=2)
        assert row.until is not None
        assert row.close_frame_id == 5

    def test_bay_state_without_map_version_rejected(self, db_client: TestClient) -> None:
        """hello without bayMapVersion: batches cannot be provenanced."""
        with db_client.websocket_connect("/ws/detect") as ws:
            send_hello(ws)
            TestBayState.send_batch(ws, 3, [{"bayId": 0, "occupied": True}])
            error: dict[str, str] = ws.receive_json()
            assert error["type"] == "error"
            assert "map version" in error["message"]
            # Nothing was recorded, and the socket stays usable.
            assert db_client.app.state.recorder.intervals() == []
            send_frame(ws, 8, make_jpeg())
            assert read_detections(ws)["frameId"] == 8

    def test_invalid_bay_map_version_rejected(self, db_client: TestClient) -> None:
        with db_client.websocket_connect("/ws/detect") as ws:
            ws.send_json(
                {"type": "hello", "captureWidth": 960, "captureHeight": 540, "bayMapVersion": ""}
            )
            error: dict[str, str] = ws.receive_json()
            assert error["type"] == "error"
            # A valid hello after the bad one still works.
            hello_with_map_version(ws, "map-hash-a")
            send_frame(ws, 9, make_jpeg())
            assert read_detections(ws)["frameId"] == 9

    def test_recorder_unavailable_replies_error_socket_stays_open(
        self, db_client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A degraded record store never takes the socket down."""
        monkeypatch.setattr(db_client.app.state, "recorder", None)
        with db_client.websocket_connect("/ws/detect") as ws:
            hello_with_map_version(ws, "map-hash-a")
            TestBayState.send_batch(ws, 4, [{"bayId": 1, "occupied": True}])
            error: dict[str, str] = ws.receive_json()
            assert error["type"] == "error"
            assert "recorder" in error["message"]
            send_frame(ws, 7, make_jpeg())
            assert read_detections(ws)["frameId"] == 7

    def test_service_restart_preserves_history(self, db_path: str) -> None:
        """ACCEPTANCE GATE (WS end-to-end): history survives a restart.

        Session 1 opens an episode; the whole app lifecycle (recorder
        included) is torn down. Session 2 is a fresh lifespan on the same
        database file: it must see the open episode and be able to close it.
        """
        from dataclasses import replace as _replace

        import app.main as main_module

        original_settings = main_module.settings
        main_module.settings = _replace(original_settings, db_path=db_path)
        try:
            with TestClient(main_module.app) as first_client:
                with first_client.websocket_connect("/ws/detect") as ws:
                    hello_with_map_version(ws, "map-hash-a")
                    TestBayState.send_batch(ws, 10, [{"bayId": 0, "occupied": True}])
                    assert ws.receive_json()["type"] == "bayStateAck"
            # Lifespan shutdown closed the recorder and released the file.

            with TestClient(main_module.app) as second_client:
                recorder2 = second_client.app.state.recorder
                rows = recorder2.intervals()
                assert len(rows) == 1
                assert rows[0].until is None
                assert rows[0].open_frame_id == 10
                with second_client.websocket_connect("/ws/detect") as ws:
                    hello_with_map_version(ws, "map-hash-a")
                    TestBayState.send_batch(ws, 11, [{"bayId": 0, "occupied": False}])
                    assert ws.receive_json()["type"] == "bayStateAck"
                [row] = recorder2.intervals()
                assert row.until is not None
                assert row.close_frame_id == 11
        finally:
            main_module.settings = original_settings


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
