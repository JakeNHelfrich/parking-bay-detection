"""API tests for /api/history (bead rzo.3): shareable read-only record.

Seeds the recorder through its public API (default wall clock = now UTC)
and queries explicit windows around "now" so assertions are deterministic
without monkeypatching the router. Any HTTP client — not just the live
socket — can review the record.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

MAP_VERSION = "feedface"


def seed(client: TestClient, events: list[dict[str, object]], frame_id: int) -> None:
    recorder = client.app.state.recorder
    assert recorder is not None
    assert recorder.record(events, MAP_VERSION, frame_id) == len(events)


def q(value: str) -> str:
    """Query-encode a timestamp ('+' in the UTC offset must not become ' ')."""
    return quote(value, safe="")


def window_around_now() -> tuple[str, str]:
    """Encoded trailing-2h window for query strings."""
    now = datetime.now(UTC)
    return q((now - timedelta(hours=1)).isoformat()), q((now + timedelta(hours=1)).isoformat())


def past_window() -> tuple[str, str]:
    """Encoded window entirely before now — nothing seeded can overlap it."""
    now = datetime.now(UTC)
    return q((now - timedelta(days=3)).isoformat()), q((now - timedelta(days=2)).isoformat())


def get(client: TestClient, path: str) -> object:
    response = client.get(path)
    assert response.status_code == 200, response.text
    return response.json()


class TestTimeline:
    def test_open_and_closed_episodes_over_a_window(self, db_client: TestClient) -> None:
        seed(db_client, [{"bayId": 0, "occupied": True, "confidence": 0.9}], 1)
        seed(db_client, [{"bayId": 1, "occupied": True, "confidence": 0.8}], 2)
        seed(db_client, [{"bayId": 1, "occupied": False}], 3)
        from_, to = window_around_now()

        from_dt = datetime.now(UTC) - timedelta(hours=1)
        to_dt = datetime.now(UTC) + timedelta(hours=1)
        payload = get(
            db_client,
            f"/api/history/timeline/0?from={q(from_dt.isoformat())}&to={q(to_dt.isoformat())}",
        )
        assert payload["bayId"] == 0
        assert datetime.fromisoformat(payload["from"]) == from_dt  # echoed, re-serialized
        assert datetime.fromisoformat(payload["to"]) == to_dt
        [entry] = payload["intervals"]
        assert entry["bayId"] == 0
        assert entry["open"] is True
        assert entry["until"] is None
        assert entry["mapVersion"] == MAP_VERSION
        assert entry["confidence"] == 0.9
        assert entry["openFrameId"] == 1
        assert entry["closeFrameId"] is None
        # Open episode accrues to the window end (~1h after seeding).
        assert 3500 < entry["durationSeconds"] < 3700

        closed = get(db_client, f"/api/history/timeline/1?from={from_}&to={to}")
        [entry] = closed["intervals"]
        assert entry["open"] is False
        assert entry["until"] is not None
        assert entry["closeFrameId"] == 3

    def test_bay_without_history_is_an_empty_list(self, db_client: TestClient) -> None:
        seed(db_client, [{"bayId": 0, "occupied": True}], 1)
        from_, to = window_around_now()
        payload = get(db_client, f"/api/history/timeline/5?from={from_}&to={to}")
        assert payload["intervals"] == []

    def test_window_excludes_out_of_range_episodes(self, db_client: TestClient) -> None:
        """A window entirely before any recorded episode matches nothing."""
        seed(db_client, [{"bayId": 0, "occupied": True}], 1)
        from_, to = past_window()
        payload = get(db_client, f"/api/history/timeline/0?from={from_}&to={to}")
        assert payload["intervals"] == []

    def test_negative_bay_id_is_rejected(self, db_client: TestClient) -> None:
        assert db_client.get("/api/history/timeline/-1").status_code == 422


class TestDwell:
    def test_per_bay_summaries_with_open_episode(self, db_client: TestClient) -> None:
        seed(db_client, [{"bayId": 0, "occupied": True, "confidence": 0.9}], 1)
        seed(db_client, [{"bayId": 1, "occupied": True}], 2)
        seed(db_client, [{"bayId": 1, "occupied": False}], 3)
        from_, to = window_around_now()

        payload = get(db_client, f"/api/history/dwell?from={from_}&to={to}")
        assert [bay["bayId"] for bay in payload["bays"]] == [0, 1]
        bay0, bay1 = payload["bays"]
        assert bay0["episodes"] == 1
        assert 3500 < bay0["totalSeconds"] < 3700
        assert bay0["open"]["since"] is not None
        assert bay0["open"]["mapVersion"] == MAP_VERSION
        assert bay0["open"]["confidence"] == 0.9
        assert bay1["episodes"] == 1
        assert bay1["open"] is None  # closed: nothing still running

    def test_single_bay_filter(self, db_client: TestClient) -> None:
        seed(db_client, [{"bayId": 0, "occupied": True}], 1)
        seed(db_client, [{"bayId": 1, "occupied": True}], 2)
        from_, to = window_around_now()
        payload = get(db_client, f"/api/history/dwell?bayId=1&from={from_}&to={to}")
        assert [bay["bayId"] for bay in payload["bays"]] == [1]

    def test_empty_record_returns_no_bays(self, db_client: TestClient) -> None:
        from_, to = window_around_now()
        payload = get(db_client, f"/api/history/dwell?from={from_}&to={to}")
        assert payload["bays"] == []


class TestRollups:
    def test_day_rollup_covers_seeded_episodes(self, db_client: TestClient) -> None:
        seed(db_client, [{"bayId": 0, "occupied": True, "confidence": 0.9}], 1)
        seed(db_client, [{"bayId": 1, "occupied": True}], 2)
        from_, to = window_around_now()

        payload = get(db_client, f"/api/history/rollups?granularity=day&from={from_}&to={to}")
        assert payload["granularity"] == "day"
        # Window spans ≤ 2 calendar days; totals across buckets are exact.
        per_bay: dict[int, float] = {}
        per_bay_episodes: dict[int, int] = {}
        for bucket in payload["buckets"]:
            for bay in bucket["bays"]:
                per_bay[bay["bayId"]] = per_bay.get(bay["bayId"], 0.0) + bay["occupiedSeconds"]
                per_bay_episodes[bay["bayId"]] = (
                    per_bay_episodes.get(bay["bayId"], 0) + bay["episodes"]
                )
        assert 3500 < per_bay[0] < 3700
        assert per_bay_episodes[0] == 1
        assert per_bay[1] >= 0.0
        assert per_bay_episodes[1] == 1

    def test_shift_rollup_buckets_align_to_start_hour(self, db_client: TestClient) -> None:
        seed(db_client, [{"bayId": 0, "occupied": True}], 1)
        from_, to = window_around_now()
        payload = get(
            db_client,
            f"/api/history/rollups?granularity=shift&shiftStartHour=0&shiftHours=1&from={from_}&to={to}",
        )
        # 2h window, 1h shifts → 2–3 buckets (first/last clipped to the
        # window); buckets tile the window exactly with no gaps or overlap.
        assert 2 <= len(payload["buckets"]) <= 3
        window_start = datetime.fromisoformat(payload["from"])
        window_end = datetime.fromisoformat(payload["to"])
        assert datetime.fromisoformat(payload["buckets"][0]["start"]) == window_start
        assert datetime.fromisoformat(payload["buckets"][-1]["end"]) == window_end
        for earlier, later in zip(payload["buckets"], payload["buckets"][1:], strict=False):
            assert earlier["end"] == later["start"]
        assert all(bay["bayId"] == 0 for bucket in payload["buckets"] for bay in bucket["bays"])

    def test_bay_filter_narrows_rollup(self, db_client: TestClient) -> None:
        seed(db_client, [{"bayId": 0, "occupied": True}], 1)
        seed(db_client, [{"bayId": 1, "occupied": True}], 2)
        from_, to = window_around_now()
        payload = get(
            db_client,
            f"/api/history/rollups?granularity=day&bayId=1&from={from_}&to={to}",
        )
        assert all(bay["bayId"] == 1 for bucket in payload["buckets"] for bay in bucket["bays"])


class TestValidationAndDegradation:
    def test_from_without_to_is_rejected(self, db_client: TestClient) -> None:
        response = db_client.get(f"/api/history/dwell?from={q(datetime.now(UTC).isoformat())}")
        assert response.status_code == 422
        assert "together" in response.json()["detail"]

    def test_naive_from_is_rejected(self, db_client: TestClient) -> None:
        response = db_client.get(
            "/api/history/dwell?from=2026-09-06T06:00:00&to=2026-09-06T18:00:00"
        )
        assert response.status_code == 422
        assert "timezone-aware" in response.json()["detail"]

    def test_inverted_window_is_rejected(self, db_client: TestClient) -> None:
        now = datetime.now(UTC)
        later = q((now + timedelta(hours=1)).isoformat())
        response = db_client.get(f"/api/history/dwell?from={later}&to={q(now.isoformat())}")
        assert response.status_code == 422
        assert "earlier than" in response.json()["detail"]

    def test_unknown_granularity_is_rejected(self, db_client: TestClient) -> None:
        assert db_client.get("/api/history/rollups?granularity=week").status_code == 422

    def test_invalid_shift_params_are_rejected(self, db_client: TestClient) -> None:
        assert (
            db_client.get("/api/history/rollups?granularity=shift&shiftHours=0").status_code == 422
        )
        assert (
            db_client.get("/api/history/rollups?granularity=shift&shiftStartHour=99").status_code
            == 422
        )

    def test_recorder_unavailable_is_503(
        self, db_client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(db_client.app.state, "recorder", None)
        from_, to = window_around_now()
        for path in (
            f"/api/history/timeline/0?from={from_}&to={to}",
            f"/api/history/dwell?from={from_}&to={to}",
            f"/api/history/rollups?from={from_}&to={to}",
        ):
            response = db_client.get(path)
            assert response.status_code == 503, path
            assert "recorder" in response.json()["detail"]
