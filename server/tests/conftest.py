"""Shared pytest fixtures.

Tests never require real YOLO weights or network access: the app under test
runs with the stub detector, and malformed-frame payloads are synthetic bytes.
"""

from __future__ import annotations

import io
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.main import app


@pytest.fixture()
def client() -> Iterator[TestClient]:
    with TestClient(app) as test_client:
        yield test_client


def make_jpeg(width: int = 64, height: int = 48) -> bytes:
    """Build a tiny valid JPEG in-memory (no files, no network)."""
    buf = io.BytesIO()
    Image.new("RGB", (width, height), color=(80, 80, 90)).save(buf, format="JPEG")
    return buf.getvalue()
