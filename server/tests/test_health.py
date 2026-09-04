"""Tests for the /health endpoint and detector load-failure behavior."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import main as app_main


def test_health_ok(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    body: dict[str, str] = response.json()
    assert body["status"] == "ok"
    assert body["model"] == "stub"


def test_health_reports_503_when_detector_load_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    """A detector that fails to load must yield 503, not a crashed service."""
    from app.detection import ModelLoadError

    def broken_create(_settings: object) -> object:
        raise ModelLoadError("simulated weight load failure")

    monkeypatch.setattr(app_main, "create_detector", broken_create)
    with TestClient(app_main.app) as test_client:
        response = test_client.get("/health")
        assert response.status_code == 503
        body: dict[str, Any] = response.json()
        assert body["status"] == "error"
        assert "simulated weight load failure" in str(body["detail"])
