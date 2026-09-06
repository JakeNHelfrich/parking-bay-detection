"""API + WebSocket tests for the alert surface (bead rzo.5).

End-to-end on the real app: alerts persist in the same SQLite record as
occupancy history, are raised by the rules sweep (on ``bayState`` batches
and before listings), surface over ``GET /api/alerts``, and acknowledge via
``POST /api/alerts/{id}/ack``. Timing-dependent rules are made deterministic
by seeding the record with back-dated episodes placed explicitly inside or
outside the active-hours window, or swapping the window for one that
excludes "now".
"""

from __future__ import annotations

import sqlite3
import time
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.alerts import ActiveHours, AlertRules
from app.main import app
from tests.conftest import make_jpeg

HOURS = ActiveHours(6, 22)  # the default window the rules engine assumes


@pytest.fixture()
def alert_state_guard() -> Any:
    """Save/restore app.state alert fields around tests that swap them."""
    saved = (app.state.alert_rules, app.state.alert_sink)
    yield app
    app.state.alert_rules, app.state.alert_sink = saved


def walk_to_inside(moment: datetime) -> datetime:
    """Walk back by hours until the wall-clock hour is inside the window."""
    while not HOURS.contains(moment):
        moment -= timedelta(hours=1)
    return moment


def outside_hours_iso() -> str:
    """The most recent timestamp outside the active window (≤30 min ago)."""
    moment = datetime.now(UTC)
    for _ in range(60):
        moment -= timedelta(minutes=30)
        if not HOURS.contains(moment):
            return moment.isoformat()
    raise AssertionError("no outside-hours moment found within 30 hours")


def seed_episode(
    db_path: str,
    bay_id: int,
    since_iso: str,
    until_iso: str | None,
    map_version: str = "map-hash-a",
) -> None:
    """Insert one occupancy episode directly (simulates a back-dated record)."""
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            INSERT INTO bay_intervals
                (bay_id, map_version, state, since, until, confidence,
                 open_frame_id, close_frame_id)
            VALUES (?, ?, 1, ?, ?, 0.9, 1, ?)
            """,
            (bay_id, map_version, since_iso, until_iso, None if until_iso is None else 2),
        )
        conn.commit()
    finally:
        conn.close()


class TestAlertListing:
    def test_empty_record_lists_no_alerts(self, db_client: TestClient) -> None:
        assert db_client.get("/api/alerts").json()["alerts"] == []

    def test_overdue_open_episode_becomes_an_overstay_alert(
        self, db_path: str, db_client: TestClient
    ) -> None:
        # A short closed episode inside active hours is quiet under defaults.
        since = walk_to_inside(datetime.now(UTC) - timedelta(hours=4))
        until = since + timedelta(minutes=30)
        seed_episode(db_path, 0, since.isoformat(), until.isoformat())
        assert db_client.get("/api/alerts").json()["alerts"] == []
        # An open episode opened ≥5h ago (inside hours) is past the
        # 240-minute dwell window; the sweep on list materializes it.
        seed_episode(
            db_path, 1, walk_to_inside(datetime.now(UTC) - timedelta(hours=5)).isoformat(), None
        )
        [alert] = db_client.get("/api/alerts").json()["alerts"]
        assert alert["bayId"] == 1
        assert alert["rule"] == "overstay"
        assert alert["detail"]["dwellMinutes"] == 240
        assert alert["detail"]["stillOpen"] is True
        assert alert["acknowledged"] is False
        assert alert["raisedAt"]  # server clock

    def test_closed_outside_hours_episode_becomes_an_after_hours_alert(
        self, db_path: str, db_client: TestClient
    ) -> None:
        since = outside_hours_iso()
        until = (datetime.fromisoformat(since) + timedelta(minutes=30)).isoformat()
        seed_episode(db_path, 2, since, until)  # 30 min < dwell → afterHours only
        [alert] = db_client.get("/api/alerts").json()["alerts"]
        assert alert["rule"] == "afterHours"
        assert alert["since"] == since

    def test_unacknowledged_filter_and_limit(self, db_path: str, db_client: TestClient) -> None:
        # Three 5h episodes opened 9h ago inside hours → one overstay each.
        for bay_id in (0, 1, 2):
            since = walk_to_inside(datetime.now(UTC) - timedelta(hours=9))
            until = since + timedelta(hours=5)  # ≤ now-4h, elapsed > 240 min
            seed_episode(db_path, bay_id, since.isoformat(), until.isoformat())
        alerts = db_client.get("/api/alerts").json()["alerts"]
        assert len(alerts) == 3
        first = alerts[0]  # newest first
        response = db_client.post(f"/api/alerts/{first['id']}/ack")
        assert response.status_code == 200
        assert response.json() == {"id": first["id"], "acknowledged": True}
        remaining = db_client.get("/api/alerts?unacknowledged=true").json()["alerts"]
        assert all(alert["id"] != first["id"] for alert in remaining)
        assert len(remaining) == 2
        assert len(db_client.get("/api/alerts?limit=1").json()["alerts"]) == 1

    def test_ack_unknown_alert_is_404(self, db_client: TestClient) -> None:
        assert db_client.post("/api/alerts/999/ack").status_code == 404

    def test_limit_bounds_are_validated(self, db_client: TestClient) -> None:
        assert db_client.get("/api/alerts?limit=0").status_code == 422
        assert db_client.get("/api/alerts?limit=501").status_code == 422

    def test_alert_store_unavailable_is_503(
        self, alert_state_guard: Any, db_client: TestClient
    ) -> None:
        app.state.alert_store = None
        response = db_client.get("/api/alerts")
        assert response.status_code == 503
        assert "unavailable" in response.json()["detail"]


def active_hours_excluding_now() -> AlertRules:
    """Rules whose active window starts 1h after the current UTC hour."""
    now_hour = datetime.now(UTC).hour
    return AlertRules(active_hours=ActiveHours((now_hour + 1) % 24, (now_hour + 2) % 24))


def connect_with_map_version(ws: Any) -> None:
    ws.send_json(
        {"type": "hello", "captureWidth": 960, "captureHeight": 540, "bayMapVersion": "map-hash-a"}
    )


class TestWebSocketRaisedAlerts:
    def test_after_hours_episode_raises_exactly_once(
        self, alert_state_guard: Any, db_client: TestClient
    ) -> None:
        # Active hours that exclude "now" → an occupation raises immediately.
        app.state.alert_rules = active_hours_excluding_now()
        with db_client.websocket_connect("/ws/detect") as ws:
            connect_with_map_version(ws)
            ws.send_json(
                {
                    "type": "bayState",
                    "frameId": 1,
                    "events": [{"bayId": 0, "occupied": True, "confidence": 0.9}],
                }
            )
            ack = ws.receive_json()
            assert ack["type"] == "bayStateAck"
            # Duplicate occupied while open is an idempotent no-op: no new alert.
            ws.send_json(
                {"type": "bayState", "frameId": 2, "events": [{"bayId": 0, "occupied": True}]}
            )
            assert ws.receive_json()["frameId"] == 2
        alerts = db_client.get("/api/alerts").json()["alerts"]
        assert len(alerts) == 1
        assert alerts[0]["rule"] == "afterHours"
        assert alerts[0]["bayId"] == 0

    def test_new_alerts_go_out_the_webhook(
        self, alert_state_guard: Any, db_client: TestClient
    ) -> None:
        delivered: list[dict[str, Any]] = []

        class StubSink:
            def deliver(self, alert: dict[str, Any]) -> None:
                delivered.append(alert)

        app.state.alert_sink = StubSink()
        app.state.alert_rules = active_hours_excluding_now()
        with db_client.websocket_connect("/ws/detect") as ws:
            connect_with_map_version(ws)
            ws.send_json(
                {"type": "bayState", "frameId": 1, "events": [{"bayId": 3, "occupied": True}]}
            )
            ws.receive_json()
        deadline = time.monotonic() + 5.0
        while not delivered and time.monotonic() < deadline:
            time.sleep(0.05)  # delivery is fire-and-forget off the event loop
        assert len(delivered) == 1
        assert delivered[0]["rule"] == "afterHours"
        assert delivered[0]["bayId"] == 3

    def test_alerts_and_history_share_the_record(
        self, alert_state_guard: Any, db_client: TestClient
    ) -> None:
        app.state.alert_rules = active_hours_excluding_now()
        with db_client.websocket_connect("/ws/detect") as ws:
            connect_with_map_version(ws)
            ws.send_json({"type": "frame", "frameId": 1})
            ws.send_bytes(make_jpeg())
            ws.receive_json()  # detections
            ws.send_json(
                {"type": "bayState", "frameId": 2, "events": [{"bayId": 0, "occupied": True}]}
            )
            ws.receive_json()  # bayStateAck
        # The alert is derived from the same episode the history API serves.
        alerts = db_client.get("/api/alerts").json()["alerts"]
        timeline = db_client.get("/api/history/timeline/0").json()
        assert alerts[0]["rule"] == "afterHours"
        assert timeline["intervals"][0]["open"] is True
