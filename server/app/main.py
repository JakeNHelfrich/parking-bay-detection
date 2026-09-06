"""FastAPI application: /health, /ws/detect, and the /api/history REST surface.

Wire protocol (backend side):

- Client sends ``{"type": "hello", "captureWidth": int, "captureHeight": int,
  "bayMapVersion": str?}`` once per session to negotiate capture size and
  (once the frontend's bay map has loaded) identify the bay-map content the
  session's bay-state reports were made under. The version is required
  before any ``bayState`` can be recorded.
- For each frame, the client sends a text header
  ``{"type": "frame", "frameId": int}`` followed by a binary message containing
  exactly one JPEG. The server replies on the same socket with
  ``{"type": "detections", "frameId", "latencyMs", "inferenceMs",
  "detections": [{"cls", "conf", "bbox": [x, y, w, h]}]}``.
- The client (the one place with the bay map) reports confirmed bay
  occupancy transitions with batched text messages
  ``{"type": "bayState", "frameId": int,
  "events": [{"bayId": int, "occupied": bool, "confidence": float?}]}`` —
  one message per frame that confirmed at least one transition. Occupancy is
  derived entirely in the frontend; the server only records what it is told
  (durable SQLite occupancy record, ``app/recorder.py``) and acknowledges
  with ``{"type": "bayStateAck", "frameId", "accepted"}`` (same frameId).
  Malformed batches get an ``error`` reply; the socket stays open. Confidence
  is present only when ``occupied`` is true. Every recorded episode is
  stamped with the session's ``bayMapVersion`` so bay-layout changes over
  time never corrupt history.
- Late-joiner handshake (rzo.6): immediately after a valid hello the server
  replies with ``{"type": "baySnapshot", "serverTime": iso, "bays": [...]}``
  listing every currently-open occupancy episode from the durable record
  (bayId, since, dwellSeconds, confidence, mapVersion) — a second viewer
  sees the yard's truth at connect without waiting for the next transition.
  The snapshot is a read-only projection of the record, never a
  re-derivation of occupancy (invariant 5); it carries no frameId because
  hello has none. Later truth still arrives the usual way: detections +
  frontend-derived bay states per frame. History beyond the live snapshot
  comes from ``/api/history``, not this socket.
- Under load the service coalesces frames (latest wins): while one frame is
  being decoded/inferred, a newer complete frame replaces the queued one, and
  superseded frames are skipped without a reply. Clients match replies by
  ``frameId`` and drop stale results, so skipping never misorders data — it
  only bounds latency when inference is slower than the capture rate.
- Malformed input (bad JSON, unknown types, undecodable JPEG, missing frame
  header) is answered with ``{"type": "error", "message": str}`` and the socket
  stays open.

REST (read-only history, alert record):

- ``GET /api/history/timeline/{bayId}?from=&to=`` — one bay's occupancy
  episodes over a window.
- ``GET /api/history/dwell?from=&to=`` — per-bay dwell summaries.
- ``GET /api/history/rollups?granularity=day|shift&from=&to=`` — occupied
  seconds per bay per day (UTC) or per shift. Aggregation lives in
  ``app/history.py``; JSON contracts in ``app/schemas.py``.
- ``GET /api/alerts?unacknowledged=&limit=`` — durable alerts derived by the
  rules engine (overstay past the bay's dwell window, after-hours activity);
  ``POST /api/alerts/{id}/ack`` acknowledges one. Rules are data
  (``alert_rules.json``: per-bay dwell windows, active hours); evaluation
  sweeps the record (no timers) on each ``bayState`` batch and before listing.
  Delivery is in-app (this surface) plus an optional webhook out
  (``PARKING_ALERT_WEBHOOK_URL``); email/SMS deferred.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.alert_store import AlertStore, StoredAlert
from app.alerts import AlertRules, AlertRulesError, load_rules
from app.api_alerts import router as alerts_router
from app.api_alerts import sweep
from app.api_history import router as history_router
from app.config import Settings, load_settings
from app.detection import (
    Detector,
    MalformedFrameError,
    ModelLoadError,
    create_detector,
    decode_jpeg,
    detections_to_wire,
)
from app.recorder import OccupancyRecorder
from app.webhook import AlertSink, sink_from_url

logger = logging.getLogger(__name__)

settings: Settings = load_settings()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Load the detector once at startup; a failure is surfaced via /health."""
    app.state.detector: Detector | None = None
    app.state.detector_error: str | None = None
    app.state.model_label: str = settings.model_name or "unknown"
    # Durable occupancy record: opened once at startup, closed at shutdown.
    # A failure to open degrades recording (bayState replies with an error)
    # instead of crashing the service — surfaced via /health like the model.
    app.state.recorder: OccupancyRecorder | None = None
    app.state.recorder_error: str | None = None
    try:
        app.state.recorder = OccupancyRecorder(settings.db_path)
    except sqlite3.Error as exc:
        app.state.recorder_error = str(exc)
    # Durable alert record + rules-as-data (bead rzo.5). Failures degrade to
    # /health surface exactly like the recorder — the live board keeps working.
    app.state.alert_store: AlertStore | None = None
    app.state.alert_error: str | None = None
    app.state.alert_rules: AlertRules | None = None
    app.state.alert_sink: AlertSink | None = None
    try:
        app.state.alert_store = AlertStore(settings.db_path)
    except sqlite3.Error as exc:
        app.state.alert_error = str(exc)
    try:
        app.state.alert_rules = load_rules(settings.alert_rules_path)
    except AlertRulesError as exc:
        app.state.alert_error = str(exc)
    app.state.alert_sink = sink_from_url(settings.alert_webhook_url)
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
    recorder: OccupancyRecorder | None = app.state.recorder
    if recorder is not None:
        recorder.close()
    alert_store: AlertStore | None = app.state.alert_store
    if alert_store is not None:
        alert_store.close()


app = FastAPI(title="parking-bay-detection", version="0.1.0", lifespan=lifespan)


@app.get("/health")
def health() -> JSONResponse:
    """Liveness + model + recorder status. 503 when the detector failed to load."""
    content: dict[str, Any] = {"status": "ok", "model": app.state.model_label}
    if app.state.recorder is None:
        content["recorder"] = {"status": "error", "detail": app.state.recorder_error}
    if app.state.alert_store is None or app.state.alert_rules is None:
        content["alerts"] = {"status": "error", "detail": app.state.alert_error}
    if app.state.detector is None:
        return JSONResponse(
            status_code=503,
            content={
                "status": "error",
                "model": app.state.model_label,
                "detail": app.state.detector_error,
            },
        )
    return JSONResponse(status_code=200, content=content)


# Read-only history REST surface (bead rzo.3) and alert record (bead rzo.5);
# registered before the static mount in `_mount_frontend` so /api routes are
# matched first.
app.include_router(history_router)
app.include_router(alerts_router)


def _validate_hello(message: dict[str, Any]) -> str | None:
    """Return an error message for an invalid hello, or None if valid."""
    width = message.get("captureWidth")
    height = message.get("captureHeight")
    if not isinstance(width, int) or isinstance(width, bool) or width <= 0:
        return "hello.captureWidth must be a positive integer"
    if not isinstance(height, int) or isinstance(height, bool) or height <= 0:
        return "hello.captureHeight must be a positive integer"
    # bayMapVersion is optional (clients without a bay map never send
    # bayState) but must be a sane string when present — it is stamped onto
    # every recorded occupancy episode.
    version = message.get("bayMapVersion")
    if version is not None and (not isinstance(version, str) or not version or len(version) > 128):
        return "hello.bayMapVersion must be a non-empty string (max 128 chars)"
    return None


def _bay_snapshot_payload(app: FastAPI) -> dict[str, Any] | None:
    """Build the late-joiner ``baySnapshot`` payload, or None when degraded.

    Read-only projection of the durable record's open episodes — the server
    never re-derives occupancy here (invariant 5): it reports exactly what
    the frontend told it, with dwell measured on the server clock.
    """
    recorder: OccupancyRecorder | None = app.state.recorder
    if recorder is None:
        return None
    now = datetime.now(UTC)
    bays: list[dict[str, Any]] = []
    for interval in recorder.intervals():
        if interval.until is not None or interval.state != 1:
            continue  # closed episodes are history (/api/history), not live state
        since = datetime.fromisoformat(interval.since)
        dwell = max(0.0, (now - since).total_seconds())
        entry: dict[str, Any] = {
            "bayId": interval.bay_id,
            "since": interval.since,
            "dwellSeconds": round(dwell, 1),
            "mapVersion": interval.map_version,
        }
        if interval.confidence is not None:
            entry["confidence"] = interval.confidence
        bays.append(entry)
    return {"type": "baySnapshot", "serverTime": now.isoformat(), "bays": bays}


def _validate_frame_header(message: dict[str, Any]) -> tuple[str | None, int | None]:
    """Return (error, frame_id) for a frame header message."""
    frame_id = message.get("frameId")
    if not isinstance(frame_id, int) or isinstance(frame_id, bool) or frame_id < 0:
        return "frame.frameId must be a non-negative integer", None
    return None, frame_id


def _validate_bay_state(message: dict[str, Any]) -> str | None:
    """Return an error message for an invalid bayState batch, or None if valid."""
    frame_id = message.get("frameId")
    if not isinstance(frame_id, int) or isinstance(frame_id, bool) or frame_id < 0:
        return "bayState.frameId must be a non-negative integer"
    events = message.get("events")
    if not isinstance(events, list) or not events:
        return "bayState.events must be a non-empty array"
    seen_bays: set[int] = set()
    for event in events:
        if not isinstance(event, dict):
            return "bayState.events entries must be objects"
        bay_id = event.get("bayId")
        if not isinstance(bay_id, int) or isinstance(bay_id, bool) or bay_id < 0:
            return "bayState.events[].bayId must be a non-negative integer"
        if bay_id in seen_bays:
            return f"bayState.events contains duplicate bayId {bay_id}"
        seen_bays.add(bay_id)
        occupied = event.get("occupied")
        if not isinstance(occupied, bool):
            return "bayState.events[].occupied must be a boolean"
        confidence = event.get("confidence")
        if confidence is not None:
            if not isinstance(confidence, (int, float)) or isinstance(confidence, bool):
                return "bayState.events[].confidence must be a number"
            if not 0.0 <= float(confidence) <= 1.0:
                return "bayState.events[].confidence must be within 0..1"
    return None


@app.websocket("/ws/detect")
async def ws_detect(socket: WebSocket) -> None:
    """Accept frames and reply with detections. Never closes on bad input.

    Frames are processed latest-wins: at most one frame is queued for
    inference at a time; when a newer complete frame arrives, the queued one
    is dropped (no reply — clients match by ``frameId`` and drop stale
    results). Inference runs off the event loop so a slow model cannot stall
    reading further frames, which is what makes coalescing effective under
    load: the backlog converges to the newest frame instead of growing.
    """
    await socket.accept()

    send_lock = asyncio.Lock()
    pending_frame_id: int | None = None
    # Bay-map content hash from the session hello; required before bayState
    # batches can be recorded (every stored episode is stamped with it).
    session_map_version: str | None = None
    # Newest complete frame awaiting inference: (frameId, payload, receivedAt).
    latest_frame: tuple[int, bytes, float] | None = None
    processing = False
    background_tasks: set[asyncio.Task[None]] = set()

    async def send_json_safe(message: dict[str, Any]) -> None:
        """Serialize sends: error replies and detection replies can race."""
        async with send_lock:
            await socket.send_json(message)

    async def process_latest() -> None:
        nonlocal latest_frame, processing
        try:
            while latest_frame is not None:
                frame_id, payload, received_at = latest_frame
                latest_frame = None  # consumed
                detector = app.state.detector
                if detector is None:
                    await send_json_safe(
                        {"type": "error", "message": "detector unavailable; see /health"}
                    )
                    continue
                try:
                    # The single decode site; pixels flow to the detector only.
                    # Off the event loop: on a slow vCPU a decode blocks reads,
                    # which delays frame intake and blunts latest-wins
                    # coalescing exactly when it matters (under load).
                    image = await asyncio.to_thread(decode_jpeg, payload)
                except MalformedFrameError as exc:
                    await send_json_safe({"type": "error", "message": str(exc)})
                    continue
                inference_start = time.perf_counter()
                try:
                    # Off the event loop: inference must not stall frame reads.
                    detections = await asyncio.to_thread(detector.infer, image, frame_id)
                except Exception as exc:  # noqa: BLE001 - keep the socket usable
                    await send_json_safe({"type": "error", "message": f"inference failed: {exc}"})
                    continue
                inference_ms = (time.perf_counter() - inference_start) * 1000.0
                latency_ms = (time.perf_counter() - received_at) * 1000.0
                await send_json_safe(
                    {
                        "type": "detections",
                        "frameId": frame_id,
                        "latencyMs": round(latency_ms, 1),
                        "inferenceMs": round(inference_ms, 1),
                        "detections": detections_to_wire(detections),
                    }
                )
        except asyncio.CancelledError:
            raise
        except Exception:
            # Client disconnected or the socket died mid-reply; stop quietly.
            pass
        finally:
            processing = False

    while True:
        message = await socket.receive()

        if message["type"] == "websocket.disconnect":
            return

        if "bytes" in message and message["bytes"] is not None:
            payload: bytes = message["bytes"]
            received_at = time.perf_counter()

            if pending_frame_id is None:
                await send_json_safe(
                    {"type": "error", "message": "binary frame without a frame header"}
                )
                continue

            frame_id = pending_frame_id
            pending_frame_id = None  # consumed

            detector = app.state.detector
            if detector is None:
                await send_json_safe(
                    {"type": "error", "message": "detector unavailable; see /health"}
                )
                continue

            # Latest-wins coalescing: queue this frame, superseding any older
            # complete frame that has not started (or finished) inference.
            latest_frame = (frame_id, payload, received_at)
            if not processing:
                processing = True
                task = asyncio.create_task(process_latest())
                # Keep a reference until done so the task cannot be GC'd mid-flight.
                background_tasks.add(task)
                task.add_done_callback(background_tasks.discard)
            continue

        # Text message: JSON control header.
        text: str | None = message.get("text")
        if text is None:
            await send_json_safe({"type": "error", "message": "unexpected empty message"})
            continue

        try:
            parsed: Any = json.loads(text)
        except ValueError:
            await send_json_safe({"type": "error", "message": "text message is not valid JSON"})
            continue

        if not isinstance(parsed, dict):
            await send_json_safe({"type": "error", "message": "text message must be a JSON object"})
            continue

        msg_type = parsed.get("type")
        if msg_type == "hello":
            error = _validate_hello(parsed)
            if error is not None:
                await send_json_safe({"type": "error", "message": error})
                continue
            # Valid hello gets the late-joiner snapshot (rzo.6): the yard's
            # current recorded truth immediately, before any frame arrives.
            # Capture size is recorded for later milestones and never leaks
            # into normalized coordinates.
            version = parsed.get("bayMapVersion")
            if isinstance(version, str) and version:
                session_map_version = version
            snapshot = _bay_snapshot_payload(app)
            if snapshot is None:
                await send_json_safe(
                    {
                        "type": "error",
                        "message": "bay snapshot unavailable: recorder degraded; see /health",
                    }
                )
            else:
                await send_json_safe(snapshot)
            continue

        if msg_type == "frame":
            error, frame_id = _validate_frame_header(parsed)
            if error is not None:
                await send_json_safe({"type": "error", "message": error})
                continue
            pending_frame_id = frame_id
            continue

        if msg_type == "bayState":
            error = _validate_bay_state(parsed)
            if error is not None:
                await send_json_safe({"type": "error", "message": error})
                continue
            events: list[Any] = parsed["events"]
            recorder: OccupancyRecorder | None = app.state.recorder
            if recorder is None:
                await send_json_safe(
                    {"type": "error", "message": "recorder unavailable; see /health"}
                )
                continue
            if session_map_version is None:
                await send_json_safe(
                    {
                        "type": "error",
                        "message": (
                            "bayState rejected: no bay map version "
                            "(send hello with bayMapVersion first)"
                        ),
                    }
                )
                continue
            # Occupancy math lives in the frontend (invariant 5): the server
            # records what it is told, never re-derives it. Each episode is
            # stamped with the session's bay map version so layout changes
            # over time never corrupt history.
            recorder.record(events, session_map_version, parsed["frameId"])
            # Alert rules sweep the record on every confirmed batch (bead
            # rzo.5): overstay/after-hours candidates become durable alerts,
            # deduped by the store, and genuinely new ones go out the
            # webhook (best-effort, off the event loop).
            new_alerts = sweep_alerts(app)
            for alert in new_alerts:
                deliver_alert(app, alert, background_tasks)
            await send_json_safe(
                {
                    "type": "bayStateAck",
                    "frameId": parsed["frameId"],
                    "accepted": len(events),
                }
            )
            continue

        await send_json_safe({"type": "error", "message": f"unknown message type: {msg_type!r}"})


def _alert_triplet(app: FastAPI) -> tuple[OccupancyRecorder, AlertStore, AlertRules] | None:
    """The (recorder, alert store, rules) trio, or None when degraded."""
    recorder: OccupancyRecorder | None = app.state.recorder
    store: AlertStore | None = app.state.alert_store
    rules: AlertRules | None = app.state.alert_rules
    if recorder is None or store is None or rules is None:
        return None
    return recorder, store, rules


def sweep_alerts(app: FastAPI) -> list[StoredAlert]:
    """Run the rules sweep; empty list when the alert surface is degraded."""
    parts = _alert_triplet(app)
    if parts is None:
        return []
    return sweep(*parts)


def alert_payload(alert: StoredAlert) -> dict[str, Any]:
    """Wire shape of an alert (matches the REST ``AlertOut`` contract)."""
    return {
        "id": alert.id,
        "bayId": alert.bay_id,
        "rule": alert.rule,
        "since": alert.since,
        "raisedAt": alert.raised_at,
        "acknowledged": alert.acknowledged,
        "detail": alert.detail,
    }


def deliver_alert(
    app: FastAPI,
    alert: StoredAlert,
    background_tasks: set[asyncio.Task[None]],
) -> None:
    """Best-effort webhook delivery, off the event loop with a timeout.

    A slow or failing webhook must never block recording or the socket:
    failures are logged and the alert remains in the durable record, so the
    in-app surface (and any later re-delivery mechanism) still has it.
    """
    sink: AlertSink | None = app.state.alert_sink
    if sink is None:
        return
    payload = alert_payload(alert)

    async def run() -> None:
        try:
            await asyncio.wait_for(asyncio.to_thread(sink.deliver, payload), timeout=10.0)
        except Exception:  # noqa: BLE001 - delivery is best-effort by contract
            logger.warning("alert webhook delivery failed for alert %s", alert.id)

    task = asyncio.create_task(run())
    background_tasks.add(task)
    task.add_done_callback(background_tasks.discard)


def _mount_frontend(application: FastAPI) -> None:
    """Serve the built frontend (if present) from the same origin.

    Single-container deployments (Fly.io) build ``frontend/dist`` into the
    image at ``settings.static_dir``; this mounts it at ``/`` so one origin
    serves both the app and ``/ws/detect``. Registered AFTER all routes and
    the WebSocket so Starlette matches those first — a ``/`` mount would
    otherwise swallow them. When the directory is absent (local dev, tests)
    nothing is mounted and the frontend runs from the Vite dev server.
    """
    static_dir = Path(settings.static_dir)
    if static_dir.is_dir():
        application.mount("/", StaticFiles(directory=static_dir, html=True), name="frontend")


_mount_frontend(app)
