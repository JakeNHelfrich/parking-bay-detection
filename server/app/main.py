"""FastAPI application: /health and /ws/detect.

Wire protocol (backend side):

- Client sends ``{"type": "hello", "captureWidth": int, "captureHeight": int}``
  once per session to negotiate capture size.
- For each frame, the client sends a text header
  ``{"type": "frame", "frameId": int}`` followed by a binary message containing
  exactly one JPEG. The server replies on the same socket with
  ``{"type": "detections", "frameId", "latencyMs", "inferenceMs",
  "detections": [{"cls", "conf", "bbox": [x, y, w, h]}]}``.
- Malformed input (bad JSON, unknown types, undecodable JPEG, missing frame
  header) is answered with ``{"type": "error", "message": str}`` and the socket
  stays open.
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, WebSocket
from fastapi.responses import JSONResponse

from app.config import Settings, load_settings
from app.detection import (
    Detector,
    MalformedFrameError,
    ModelLoadError,
    create_detector,
    decode_jpeg,
    detections_to_wire,
)

settings: Settings = load_settings()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Load the detector once at startup; a failure is surfaced via /health."""
    app.state.detector: Detector | None = None
    app.state.detector_error: str | None = None
    app.state.model_label: str = settings.model_name or "unknown"
    try:
        detector = create_detector(settings)
        # Lazily-loaded backends expose ensure_loaded; force the weight load
        # here (once, at startup) so failures surface on /health, not mid-frame.
        ensure_loaded = getattr(detector, "ensure_loaded", None)
        if ensure_loaded is not None:
            ensure_loaded()
        app.state.detector = detector
        app.state.model_label = getattr(detector, "model_label", settings.model_name or "unknown")
    except ModelLoadError as exc:
        # Keep the app up: /health reports 503 instead of crashing the service.
        app.state.detector_error = str(exc)
    yield


app = FastAPI(title="parking-bay-detection", version="0.1.0", lifespan=lifespan)


@app.get("/health")
def health() -> JSONResponse:
    """Liveness + model status. 503 when the detector failed to load."""
    if app.state.detector is None:
        return JSONResponse(
            status_code=503,
            content={
                "status": "error",
                "model": app.state.model_label,
                "detail": app.state.detector_error,
            },
        )
    return JSONResponse(
        status_code=200,
        content={"status": "ok", "model": app.state.model_label},
    )


async def _send_error(socket: WebSocket, message: str) -> None:
    """Report a recoverable protocol error; the socket stays open."""
    await socket.send_json({"type": "error", "message": message})


def _validate_hello(message: dict[str, Any]) -> str | None:
    """Return an error message for an invalid hello, or None if valid."""
    width = message.get("captureWidth")
    height = message.get("captureHeight")
    if not isinstance(width, int) or isinstance(width, bool) or width <= 0:
        return "hello.captureWidth must be a positive integer"
    if not isinstance(height, int) or isinstance(height, bool) or height <= 0:
        return "hello.captureHeight must be a positive integer"
    return None


def _validate_frame_header(message: dict[str, Any]) -> tuple[str | None, int | None]:
    """Return (error, frame_id) for a frame header message."""
    frame_id = message.get("frameId")
    if not isinstance(frame_id, int) or isinstance(frame_id, bool) or frame_id < 0:
        return "frame.frameId must be a non-negative integer", None
    return None, frame_id


@app.websocket("/ws/detect")
async def ws_detect(socket: WebSocket) -> None:
    """Accept frames and reply with detections. Never closes on bad input."""
    await socket.accept()

    pending_frame_id: int | None = None

    while True:
        message = await socket.receive()

        if message["type"] == "websocket.disconnect":
            return

        if "bytes" in message and message["bytes"] is not None:
            payload: bytes = message["bytes"]
            received_at = time.perf_counter()

            if pending_frame_id is None:
                await _send_error(socket, "binary frame without a frame header")
                continue

            frame_id = pending_frame_id
            pending_frame_id = None  # consumed

            detector = app.state.detector
            if detector is None:
                await _send_error(socket, "detector unavailable; see /health")
                continue

            try:
                # The single decode site; pixels flow to the detector only.
                image = decode_jpeg(payload)
            except MalformedFrameError as exc:
                await _send_error(socket, str(exc))
                continue

            inference_start = time.perf_counter()
            detections = detector.infer(image, frame_id=frame_id)
            inference_ms = (time.perf_counter() - inference_start) * 1000.0
            latency_ms = (time.perf_counter() - received_at) * 1000.0

            await socket.send_json(
                {
                    "type": "detections",
                    "frameId": frame_id,
                    "latencyMs": round(latency_ms, 1),
                    "inferenceMs": round(inference_ms, 1),
                    "detections": detections_to_wire(detections),
                }
            )
            continue

        # Text message: JSON control header.
        text: str | None = message.get("text")
        if text is None:
            await _send_error(socket, "unexpected empty message")
            continue

        try:
            parsed: Any = json.loads(text)
        except ValueError:
            await _send_error(socket, "text message is not valid JSON")
            continue

        if not isinstance(parsed, dict):
            await _send_error(socket, "text message must be a JSON object")
            continue

        msg_type = parsed.get("type")
        if msg_type == "hello":
            error = _validate_hello(parsed)
            if error is not None:
                await _send_error(socket, error)
            # Valid hello needs no reply; capture size is recorded for later
            # milestones and never leaks into normalized coordinates.
            continue

        if msg_type == "frame":
            error, frame_id = _validate_frame_header(parsed)
            if error is not None:
                await _send_error(socket, error)
                continue
            pending_frame_id = frame_id
            continue

        await _send_error(socket, f"unknown message type: {msg_type!r}")
