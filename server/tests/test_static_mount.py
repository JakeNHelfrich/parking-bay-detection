"""Tests for the optional single-origin static (frontend) mount.

``_mount_frontend`` mounts ``PARKING_STATIC_DIR`` (a built frontend/dist) at
``/`` in the single-container deploy image. These tests drive the real helper
against the real app (mount added last, popped after each test) and assert the
API routes and WebSocket still take precedence over the ``/`` mount.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import main as app_main


@pytest.fixture()
def static_dir(tmp_path: Path) -> Path:
    """A throwaway 'frontend build': index.html plus a static asset."""
    directory = tmp_path / "static"
    directory.mkdir()
    (directory / "index.html").write_text(
        "<!doctype html><title>parking-bay-detection</title>", encoding="utf-8"
    )
    return directory


@pytest.fixture()
def mounted_app(static_dir: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[object]:
    """The real app with the frontend mount temporarily added."""
    monkeypatch.setattr(
        app_main, "settings", replace(app_main.settings, static_dir=str(static_dir))
    )
    routes_before = len(app_main.app.router.routes)
    app_main._mount_frontend(app_main.app)
    yield app_main.app
    del app_main.app.router.routes[routes_before:]


def test_index_served_from_static_dir(mounted_app: object) -> None:
    with TestClient(mounted_app) as test_client:
        response = test_client.get("/")
        assert response.status_code == 200
        assert "parking-bay-detection" in response.text


def test_health_takes_precedence_over_mount(mounted_app: object) -> None:
    """The JSON /health route must win even when the frontend is mounted at /."""
    with TestClient(mounted_app) as test_client:
        response = test_client.get("/health")
        assert response.status_code == 200
        assert response.json()["status"] == "ok"


def test_websocket_takes_precedence_over_mount(
    mounted_app: object,  # noqa: ARG001 - fixture wires the mount
) -> None:
    """The /ws/detect route must stay reachable when the frontend is mounted."""
    from tests.conftest import make_jpeg

    with TestClient(mounted_app) as test_client:
        with test_client.websocket_connect("/ws/detect") as ws:
            ws.send_json({"type": "hello", "captureWidth": 64, "captureHeight": 64})
            hello_reply = ws.receive_json()
            assert hello_reply["type"] in ("baySnapshot", "error")  # rzo.6 late-joiner reply
            ws.send_json({"type": "frame", "frameId": 7})
            ws.send_bytes(make_jpeg())
            reply = ws.receive_json()
            assert reply["type"] == "detections"
            assert reply["frameId"] == 7


def test_missing_static_dir_mounts_nothing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """An absent static dir (local dev / tests) must leave the app unchanged."""
    monkeypatch.setattr(
        app_main,
        "settings",
        replace(app_main.settings, static_dir=str(tmp_path / "does-not-exist")),
    )
    routes_before = len(app_main.app.router.routes)
    app_main._mount_frontend(app_main.app)
    assert len(app_main.app.router.routes) == routes_before  # nothing mounted
    with TestClient(app_main.app) as test_client:
        assert test_client.get("/health").status_code == 200
