"""Pluggable alert delivery (bead rzo.5) — in-app first, webhook out.

The UI reads alerts from ``GET /api/alerts`` (in-app delivery); this module is
the *out* channel: a tiny sink abstraction so delivery targets stay pluggable
(email/SMS are deferred — they would be further ``AlertSink`` implementations,
not new alert logic). The default sink is a null object; an HTTP webhook is
enabled by ``PARKING_ALERT_WEBHOOK_URL``.

Delivery is best-effort by contract: a failing or slow webhook must never
break recording or the WebSocket path. Callers run ``deliver`` off the event
loop (``asyncio.to_thread``) with a timeout and log failures.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Protocol


class AlertSink(Protocol):
    """A delivery target for raised alerts (webhook now, email/SMS later)."""

    def deliver(self, alert: dict[str, Any]) -> None:
        """Deliver one alert payload; raise on failure (caller logs)."""
        ...


class NullSink:
    """Default sink: in-app only, nothing delivered out."""

    def deliver(self, alert: dict[str, Any]) -> None:  # noqa: ARG002 - protocol shape
        return None


class HttpWebhookSink:
    """POSTs the alert JSON to a configured URL (fire-and-forget semantics).

    Any 2xx counts as delivered; anything else (or a network error, or a
    timeout) raises so the caller can log and move on — alerts stay in the
    durable record either way, so a missed webhook is not data loss.
    """

    def __init__(self, url: str, timeout_seconds: float = 5.0) -> None:
        self._url = url
        self._timeout = timeout_seconds

    def deliver(self, alert: dict[str, Any]) -> None:
        payload = json.dumps(alert).encode()
        request = urllib.request.Request(
            self._url,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        # urlopen raises on non-2xx (HTTPError) and on network errors/timeout:
        # exactly the contract — any failure propagates so the caller logs and
        # moves on; the alert stays in the durable record either way.
        with urllib.request.urlopen(request, timeout=self._timeout):
            pass


def sink_from_url(url: str | None) -> AlertSink:
    """Pick the sink for the configured webhook URL (''/'None' → in-app only)."""
    if url and url.strip() and url.strip().lower() != "none":
        return HttpWebhookSink(url.strip())
    return NullSink()
