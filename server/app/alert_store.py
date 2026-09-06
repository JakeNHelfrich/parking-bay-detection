"""Durable alert record (SQLite) — bead rzo.5.

Alerts persist *with the record*: the same ``PARKING_DB_PATH`` database that
holds occupancy episodes holds the alerts the rules engine derives from them,
so both survive a restart together. One row per (rule, episode): the unique
constraint is what makes the engine's sweep idempotent — re-evaluating the
same episode can never duplicate an alert, and a duplicate insert is reported
as "not new" so delivery (webhook) fires exactly once per alert.

All writes happen on the event-loop thread (lifespan + WebSocket handler +
sync route handlers); ``check_same_thread=False`` exists only so tests may
read the database from the test thread.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from app.alerts import AlertCandidate

_SCHEMA = """
CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Stable bay identity from the wire (invariant 5).
    bay_id INTEGER NOT NULL,
    -- Which rule fired ('overstay' | 'afterHours').
    rule TEXT NOT NULL,
    -- The occupancy episode that triggered the alert; unique per rule so a
    -- sweep is idempotent and a redelivery cannot double-raise.
    interval_id INTEGER NOT NULL,
    -- Bay-map content hash the triggering episode was observed under.
    map_version TEXT NOT NULL,
    -- Opening time of the triggering episode (ISO 8601, UTC).
    since TEXT NOT NULL,
    -- Server clock when the alert was first raised.
    raised_at TEXT NOT NULL,
    -- Rule-specific detail (dwell minutes, elapsed, active hours, ...).
    detail TEXT NOT NULL,
    acknowledged INTEGER NOT NULL DEFAULT 0,
    UNIQUE (rule, interval_id)
);
CREATE INDEX IF NOT EXISTS idx_alerts_ack ON alerts (acknowledged, id);
"""


@dataclass(frozen=True)
class StoredAlert:
    """One persisted alert as surfaced over the REST API."""

    id: int
    bay_id: int
    rule: str
    interval_id: int
    map_version: str
    since: str
    raised_at: str
    detail: dict[str, Any]
    acknowledged: bool


def _utcnow() -> datetime:
    return datetime.now(UTC)


class AlertStore:
    """Persists derived alerts; dedup by (rule, episode)."""

    def __init__(
        self,
        db_path: str,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._clock = clock or _utcnow
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.executescript(_SCHEMA)
        self._conn.commit()

    def raise_new(self, candidates: Sequence[AlertCandidate]) -> list[StoredAlert]:
        """Persist candidates; return only the ones that are genuinely new.

        ``INSERT OR IGNORE`` against the unique ``(rule, interval_id)``
        constraint: a candidate the store has already seen is silently
        dropped, so callers can sweep as often as they like and deliver
        exactly once per alert.
        """
        raised: list[StoredAlert] = []
        for candidate in candidates:
            raised_at = self._clock().isoformat()
            cursor = self._conn.execute(
                """
                INSERT OR IGNORE INTO alerts
                    (bay_id, rule, interval_id, map_version, since, raised_at,
                     detail, acknowledged)
                VALUES (?, ?, ?, ?, ?, ?, ?, 0)
                """,
                (
                    candidate.bay_id,
                    candidate.rule,
                    candidate.interval_id,
                    candidate.map_version,
                    candidate.since,
                    raised_at,
                    json.dumps(candidate.detail),
                ),
            )
            if cursor.rowcount != 1:
                continue  # duplicate — already raised for this rule/episode
            stored = self._get(cursor.lastrowid)
            if stored is not None:
                raised.append(stored)
        self._conn.commit()
        return raised

    def _get(self, alert_id: int) -> StoredAlert | None:
        row = self._conn.execute(
            """
            SELECT id, bay_id, rule, interval_id, map_version, since, raised_at,
                   detail, acknowledged
            FROM alerts WHERE id = ?
            """,
            (alert_id,),
        ).fetchone()
        return None if row is None else _row_to_alert(row)

    def list(self, unacknowledged_only: bool = False, limit: int = 100) -> list[StoredAlert]:
        """Alerts, newest first (optionally only unacknowledged ones)."""
        query = """
            SELECT id, bay_id, rule, interval_id, map_version, since, raised_at,
                   detail, acknowledged
            FROM alerts
        """
        if unacknowledged_only:
            query += " WHERE acknowledged = 0"
        query += " ORDER BY id DESC LIMIT ?"
        rows: Iterable[Any] = self._conn.execute(query, (limit,))
        return [_row_to_alert(row) for row in rows]

    def acknowledge(self, alert_id: int) -> bool:
        """Mark one alert acknowledged; False when the id is unknown."""
        cursor = self._conn.execute(
            "UPDATE alerts SET acknowledged = 1 WHERE id = ?",
            (alert_id,),
        )
        self._conn.commit()
        return cursor.rowcount == 1

    def close(self) -> None:
        """Flush and close the database (called on service shutdown)."""
        self._conn.commit()
        self._conn.close()


def _row_to_alert(row: Any) -> StoredAlert:
    (
        alert_id,
        bay_id,
        rule,
        interval_id,
        map_version,
        since,
        raised_at,
        detail,
        acknowledged,
    ) = row
    return StoredAlert(
        id=alert_id,
        bay_id=bay_id,
        rule=rule,
        interval_id=interval_id,
        map_version=map_version,
        since=since,
        raised_at=raised_at,
        detail=json.loads(detail),
        acknowledged=bool(acknowledged),
    )
