"""Tests for the /health endpoint and detector load-failure behavior."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app import main as app_main
from app.config import Settings


def test_health_ok(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    body: dict[str, str] = response.json()
    assert body["status"] == "ok"
    assert body["model"] == "stub"


def test_health_reports_503_when_detector_load_fails() -> None:
    """A detector that fails to load must yield 503, not a crashed service."""
    broken = Settings(detector="yolo")  # yolo backend not implemented yet

    original_settings = app_main.settings
    app_main.settings = broken
    try:
        with TestClient(app_main.app) as test_client:
            response = test_client.get("/health")
            assert response.status_code == 503
            body: dict[str, Any] = response.json()
            assert body["status"] == "error"
            assert "M4" in str(body["detail"])
    finally:
        app_main.settings = original_settings
