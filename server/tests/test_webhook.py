"""Webhook delivery tests (bead rzo.5) — pluggable sink, best-effort contract.

Covers sink selection from config, real HTTP delivery against a local
stdlib server, and the fire-and-forget helper: a failing/slow webhook must
never raise out of ``deliver_alert`` — the alert stays in the durable record.
"""

from __future__ import annotations

import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any
from urllib.error import HTTPError

import pytest

from app.alert_store import StoredAlert
from app.main import alert_payload, deliver_alert
from app.webhook import HttpWebhookSink, NullSink, sink_from_url


class RecordingSink:
    """Stub sink capturing payloads (stands in for any pluggable target)."""

    def __init__(self) -> None:
        self.delivered: list[dict[str, Any]] = []
        self.fail = False

    def deliver(self, alert: dict[str, Any]) -> None:
        if self.fail:
            raise RuntimeError("webhook down")
        self.delivered.append(alert)


def make_stored_alert(alert_id: int = 7) -> StoredAlert:
    return StoredAlert(
        id=alert_id,
        bay_id=0,
        rule="overstay",
        interval_id=1,
        map_version="feedface",
        since="2026-09-06T08:00:00+00:00",
        raised_at="2026-09-06T12:00:00+00:00",
        detail={"dwellMinutes": 240, "elapsedMinutes": 240.5, "stillOpen": True},
        acknowledged=False,
    )


class TestSinkSelection:
    def test_empty_or_none_url_means_in_app_only(self) -> None:
        assert isinstance(sink_from_url(""), NullSink)
        assert isinstance(sink_from_url(None), NullSink)
        assert isinstance(sink_from_url("  none "), NullSink)

    def test_url_selects_http_sink(self) -> None:
        sink = sink_from_url("https://example.test/hook")
        assert isinstance(sink, HttpWebhookSink)


class TestHttpWebhookSink:
    def test_delivers_alert_json(self) -> None:
        received: list[dict[str, Any]] = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 - stdlib API
                length = int(self.headers.get("Content-Length", "0"))
                received.append(json.loads(self.rfile.read(length)))
                self.send_response(204)
                self.end_headers()

            def log_message(self, *args: Any) -> None:
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            sink = HttpWebhookSink(f"http://127.0.0.1:{server.server_port}/hook")
            sink.deliver(alert_payload(make_stored_alert()))
            assert received == [alert_payload(make_stored_alert())]
        finally:
            server.shutdown()
            thread.join(timeout=2)

    def test_non_2xx_raises(self) -> None:
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 - stdlib API
                self.send_response(500)
                self.end_headers()

            def log_message(self, *args: Any) -> None:
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            sink = HttpWebhookSink(f"http://127.0.0.1:{server.server_port}/hook")
            with pytest.raises(HTTPError):
                sink.deliver(alert_payload(make_stored_alert()))
        finally:
            server.shutdown()
            thread.join(timeout=2)


class TestDeliverAlert:
    def test_delivers_to_sink(self) -> None:
        sink = RecordingSink()
        app = type("App", (), {"state": type("State", (), {"alert_sink": sink})()})()
        deliver_alert_sync(app, make_stored_alert())
        assert len(sink.delivered) == 1
        assert sink.delivered[0]["rule"] == "overstay"

    def test_failure_never_raises(self) -> None:
        sink = RecordingSink()
        sink.fail = True
        app = type("App", (), {"state": type("State", (), {"alert_sink": sink})()})()
        deliver_alert_sync(app, make_stored_alert())  # must not raise
        assert sink.delivered == []


def deliver_alert_sync(app: Any, alert: StoredAlert) -> None:
    """Run the async fire-and-forget delivery to completion for testing."""
    tasks: set[asyncio.Task[None]] = set()

    async def scenario() -> None:
        deliver_alert(app, alert, tasks)
        assert len(tasks) == 1
        await asyncio.gather(*tasks)

    asyncio.run(scenario())
