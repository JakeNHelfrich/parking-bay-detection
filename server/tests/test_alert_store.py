"""Alert store unit tests (bead rzo.5) — persistence, dedup, ack, restart.

The restart test is the acceptance gate: alerts persist *with the record*,
so a full close/reopen of the store must keep raised alerts and keep the
dedup working (a re-swept episode never re-raises after a restart).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

from app.alert_store import AlertStore
from app.alerts import AlertCandidate


class SteppedClock:
    """Injectable clock: starts at a fixed UTC time, steps 1 min per call."""

    def __init__(self, start: datetime) -> None:
        self._now = start

    def __call__(self) -> datetime:
        current = self._now
        self._now += timedelta(minutes=1)
        return current


def candidate(
    interval_id: int,
    rule: str = "overstay",
    bay_id: int = 0,
    since: str = "2026-09-06T08:00:00+00:00",
) -> AlertCandidate:
    return AlertCandidate(
        bay_id=bay_id,
        rule=rule,
        interval_id=interval_id,
        map_version="feedface",
        since=since,
        detail={"dwellMinutes": 60},
    )


def test_raise_new_persists_and_returns_new_only(tmp_path: Path) -> None:
    store = AlertStore(str(tmp_path / "alerts.db"), clock=SteppedClock(datetime.now(UTC)))
    try:
        [first] = store.raise_new([candidate(1)])
        assert first.id == 1
        assert first.rule == "overstay"
        assert first.detail == {"dwellMinutes": 60}
        assert first.acknowledged is False
        # Re-raising the same (rule, episode) is a no-op — exactly-once.
        assert store.raise_new([candidate(1)]) == []
    finally:
        store.close()


def test_different_rules_and_episodes_are_distinct(tmp_path: Path) -> None:
    store = AlertStore(str(tmp_path / "alerts.db"), clock=SteppedClock(datetime.now(UTC)))
    try:
        raised = store.raise_new(
            [candidate(1), candidate(1, rule="afterHours"), candidate(2, bay_id=3)]
        )
        assert len(raised) == 3
    finally:
        store.close()


def test_list_orders_newest_first_and_filters(tmp_path: Path) -> None:
    clock = SteppedClock(datetime.fromisoformat("2026-09-06T08:00:00+00:00"))
    store = AlertStore(str(tmp_path / "alerts.db"), clock=clock)
    try:
        [a, b] = store.raise_new([candidate(1), candidate(2)])
        store.acknowledge(a.id)
        assert [alert.id for alert in store.list()] == [b.id, a.id]
        assert [alert.id for alert in store.list(unacknowledged_only=True)] == [b.id]
    finally:
        store.close()


def test_acknowledge_unknown_id_is_false(tmp_path: Path) -> None:
    store = AlertStore(str(tmp_path / "alerts.db"))
    try:
        assert store.acknowledge(999) is False
    finally:
        store.close()


class TestRestartPersistence:
    def test_alerts_and_dedup_survive_reopen(self, tmp_path: Path) -> None:
        db = str(tmp_path / "alerts.db")
        first = AlertStore(
            db, clock=SteppedClock(datetime.fromisoformat("2026-09-06T08:00:00+00:00"))
        )
        try:
            [raised] = first.raise_new([candidate(7)])
        finally:
            first.close()

        # Full close/reopen — exactly like a service restart.
        second = AlertStore(
            db, clock=SteppedClock(datetime.fromisoformat("2026-09-06T12:00:00+00:00"))
        )
        try:
            alerts = second.list()
            assert [alert.id for alert in alerts] == [raised.id]
            assert alerts[0].raised_at == raised.raised_at
            # The store still remembers the episode was alerted: no re-raise.
            assert second.raise_new([candidate(7)]) == []
        finally:
            second.close()


def test_database_integrity(tmp_path: Path) -> None:
    db = str(tmp_path / "alerts.db")
    store = AlertStore(db)
    store.raise_new([candidate(1), candidate(2, rule="afterHours")])
    store.close()
    import sqlite3

    conn = sqlite3.connect(db)
    try:
        (result,) = conn.execute("PRAGMA integrity_check").fetchone()
        assert result == "ok"
    finally:
        conn.close()
