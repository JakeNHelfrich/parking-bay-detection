"""Recorder unit tests: durable bay-occupancy record (bead rzo.2).

Pure persistence logic against a temporary SQLite file with an injected
clock. The restart-persistence test at the bottom is the bead's acceptance
gate: history (open and closed episodes) must survive a full close/reopen
of the recorder, exactly like a service restart.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from app.recorder import OccupancyRecorder


class SteppedClock:
    """Injectable clock: starts at a fixed UTC time, steps 1 min per call."""

    def __init__(self, start: datetime) -> None:
        self._now = start

    def __call__(self) -> datetime:
        current = self._now
        self._now += timedelta(minutes=1)
        return current


@pytest.fixture()
def db_path(tmp_path: Path) -> str:
    return str(tmp_path / "occupancy.db")


def make_recorder(db_path: str, start: str = "2026-09-06T08:00:00+00:00") -> OccupancyRecorder:
    return OccupancyRecorder(
        db_path,
        clock=SteppedClock(datetime.fromisoformat(start)),
    )


def occupied(bay_id: int, confidence: float | None = 0.9) -> dict[str, object]:
    event: dict[str, object] = {"bayId": bay_id, "occupied": True}
    if confidence is not None:
        event["confidence"] = confidence
    return event


def empty(bay_id: int) -> dict[str, object]:
    return {"bayId": bay_id, "occupied": False}


class TestIntervalLifecycle:
    def test_open_then_close_writes_one_episode(self, db_path: str) -> None:
        recorder = make_recorder(db_path)
        assert recorder.record([occupied(0)], "mapv1", 10) == 1
        assert recorder.record([empty(0)], "mapv1", 12) == 1
        recorder.close()

        rows = make_recorder(db_path).intervals()
        assert len(rows) == 1
        row = rows[0]
        assert row.bay_id == 0
        assert row.state == 1
        assert row.map_version == "mapv1"
        assert row.since == "2026-09-06T08:00:00+00:00"
        assert row.until == "2026-09-06T08:01:00+00:00"
        assert row.confidence == pytest.approx(0.9)
        assert row.open_frame_id == 10
        assert row.close_frame_id == 12

    def test_open_episode_has_null_until(self, db_path: str) -> None:
        recorder = make_recorder(db_path)
        recorder.record([occupied(2, confidence=None)], "mapv1", 1)
        [row] = recorder.intervals()
        assert row.until is None
        assert row.close_frame_id is None
        assert row.confidence is None  # reporter supplied none
        recorder.close()

    def test_empty_without_open_is_a_noop(self, db_path: str) -> None:
        recorder = make_recorder(db_path)
        assert recorder.record([empty(0)], "mapv1", 1) == 0
        assert recorder.intervals() == []
        recorder.close()

    def test_duplicate_occupied_is_idempotent(self, db_path: str) -> None:
        """A redelivered open report must never fabricate a second episode."""
        recorder = make_recorder(db_path)
        assert recorder.record([occupied(0)], "mapv1", 1) == 1
        assert recorder.record([occupied(0)], "mapv1", 2) == 0
        assert recorder.record([occupied(0), occupied(0)], "mapv1", 3) == 0
        assert len(recorder.intervals()) == 1
        recorder.close()

    def test_reopen_after_close_starts_a_new_episode(self, db_path: str) -> None:
        recorder = make_recorder(db_path)
        recorder.record([occupied(0)], "mapv1", 1)
        recorder.record([empty(0)], "mapv1", 2)
        recorder.record([occupied(0)], "mapv1", 3)
        rows = recorder.intervals()
        assert len(rows) == 2
        assert [row.until for row in rows] != [None, None]
        assert rows[1].since > rows[0].until
        recorder.close()

    def test_batch_of_transitions_applies_in_order(self, db_path: str) -> None:
        recorder = make_recorder(db_path)
        written = recorder.record([occupied(0), occupied(1), empty(1)], "mapv1", 5)
        assert written == 3  # bay 0 open, bay 1 open, bay 1 closed
        rows = recorder.intervals()
        assert len(rows) == 2
        bay1 = [row for row in rows if row.bay_id == 1]
        assert bay1[0].until is not None
        recorder.close()

    def test_intervals_filter_by_bay(self, db_path: str) -> None:
        recorder = make_recorder(db_path)
        recorder.record([occupied(0), occupied(3)], "mapv1", 1)
        assert [row.bay_id for row in recorder.intervals(bay_id=3)] == [3]
        recorder.close()


class TestMapVersionProvenance:
    def test_each_episode_stamps_its_own_map_version(self, db_path: str) -> None:
        recorder = make_recorder(db_path)
        recorder.record([occupied(0)], "map-hash-a", 1)
        recorder.record([empty(0)], "map-hash-a", 2)
        # Bay layout changes (same stable bay id, new rects → new map hash).
        recorder.record([occupied(0)], "map-hash-b", 3)
        rows = recorder.intervals()
        assert [row.map_version for row in rows] == ["map-hash-a", "map-hash-b"]
        recorder.close()

    def test_closing_under_a_new_map_keeps_opening_provenance(self, db_path: str) -> None:
        """The episode opened under the old map; the close only ends it.

        Bay ids are stable across layouts (invariant 5), so the interval is
        never corrupted — the row's ``map_version`` records which bay map the
        observation was made under.
        """
        recorder = make_recorder(db_path)
        recorder.record([occupied(0)], "map-hash-a", 1)
        recorder.record([empty(0)], "map-hash-b", 2)
        [row] = recorder.intervals()
        assert row.map_version == "map-hash-a"
        assert row.until is not None  # still correctly closed
        recorder.close()


class TestRestartPersistence:
    def test_history_survives_a_restart(self, db_path: str) -> None:
        """ACCEPTANCE GATE: the record survives a full service restart.

        Session 1 records a closed episode and leaves another open; the
        recorder (and its file handle) is fully torn down like a service
        shutdown. Session 2 reopens the same database file cold and must see
        both episodes, keep the open one open, and be able to close it with
        a post-restart report.
        """
        # --- service run 1 ---
        first = make_recorder(db_path)
        first.record([occupied(0), occupied(1)], "mapv1", 10)
        first.record([empty(0)], "mapv1", 11)  # bay 0 closed; bay 1 still open
        first.close()

        # --- service restart: nothing in memory carries over ---
        second = make_recorder(db_path, start="2026-09-06T09:00:00+00:00")
        rows = second.intervals()
        assert len(rows) == 2

        bay0 = next(row for row in rows if row.bay_id == 0)
        assert bay0.until is not None  # closed episode survived intact
        assert bay0.open_frame_id == 10
        assert bay0.close_frame_id == 11

        bay1 = next(row for row in rows if row.bay_id == 1)
        assert bay1.until is None  # open episode survives; the truck may remain
        assert bay1.map_version == "mapv1"

        # A post-restart report still lands on the pre-restart episode.
        assert second.record([empty(1)], "mapv1", 20) == 1
        [bay1_after] = second.intervals(bay_id=1)
        assert bay1_after.until == "2026-09-06T09:00:00+00:00"
        assert bay1_after.close_frame_id == 20

        # A post-restart occupied report after the close opens a new episode.
        assert second.record([occupied(1)], "mapv1", 21) == 1
        assert len(second.intervals(bay_id=1)) == 2
        second.close()

    def test_database_is_valid_sqlite_after_restart(self, db_path: str) -> None:
        """The file on disk is a well-formed SQLite db, not just readable."""
        first = make_recorder(db_path)
        first.record([occupied(0)], "mapv1", 1)
        first.close()

        connection = sqlite3.connect(db_path)
        try:
            (count,) = connection.execute("SELECT COUNT(*) FROM bay_intervals").fetchone()
            assert count == 1
            (integrity,) = connection.execute("PRAGMA integrity_check").fetchone()
            assert integrity == "ok"
        finally:
            connection.close()
