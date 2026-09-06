"""Shared pytest fixtures.

Tests never require real YOLO weights or network access: the app under test
runs with the stub detector, and malformed-frame payloads are synthetic bytes.
"""

from __future__ import annotations

import io
from collections.abc import Iterator
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.main import app


@pytest.fixture()
def client() -> Iterator[TestClient]:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def db_path(tmp_path: Path) -> str:
    """Temporary SQLite file for the durable occupancy record."""
    return str(tmp_path / "occupancy.db")


@pytest.fixture()
def db_client(db_path: str) -> Iterator[TestClient]:
    """TestClient whose lifespan opens the recorder on a temporary db file."""
    import app.main as main_module

    original_settings = main_module.settings
    main_module.settings = replace(original_settings, db_path=db_path)
    try:
        with TestClient(main_module.app) as test_client:
            yield test_client
    finally:
        main_module.settings = original_settings


def make_jpeg(width: int = 64, height: int = 48) -> bytes:
    """Build a tiny valid JPEG in-memory (no files, no network)."""
    buf = io.BytesIO()
    Image.new("RGB", (width, height), color=(80, 80, 90)).save(buf, format="JPEG")
    return buf.getvalue()
