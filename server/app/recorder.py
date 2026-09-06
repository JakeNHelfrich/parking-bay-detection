"""Durable bay-occupancy record (SQLite) — bead rzo.2.

The frontend owns occupancy math (invariant 5); this module only persists
what it is told. Each accepted transition updates an *interval* row: an
``occupied`` report opens an episode (``since`` set, ``until`` NULL), an
``empty`` report closes the newest open episode for that bay. Empty spans
are simply the gaps between intervals.

Bay layout changes over time must not corrupt history: bay identity is the
stable ``bayId`` (invariant 5), and every row records the ``map_version``
content hash of the bay map the opening observation was made under.

Event handling is idempotent by design — a duplicate ``occupied`` report
for an already-open bay is a no-op, as is an ``empty`` report for a bay
with no open episode — so reconnects or redeliveries cannot double-open or
fabricate history. Open episodes intentionally survive a service restart
untouched (the truck may still be there; the next report closes or
confirms them) — the restart test in ``tests/test_recorder.py`` pins this.

All writes happen on the event-loop thread (lifespan + WebSocket handler);
``check_same_thread=False`` exists only so tests may read the database from
the test thread.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

_SCHEMA = """
CREATE TABLE IF NOT EXISTS bay_intervals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Stable bay identity from the wire (invariant 5) — never model-derived.
    bay_id INTEGER NOT NULL,
    -- Content hash of the bay map the opening observation was made under.
    map_version TEXT NOT NULL,
    -- Occupied episode; 1 by construction today (empty spans are gaps).
    state INTEGER NOT NULL CHECK (state IN (0, 1)),
    -- Server-clock timestamps (ISO 8601, UTC) of the opening/closing report.
    since TEXT NOT NULL,
    until TEXT,
    -- Matched-truck confidence at open, when the reporter supplied one.
    confidence REAL,
    -- Source wire frameIds of the reports that opened/closed the episode.
    open_frame_id INTEGER NOT NULL,
    close_frame_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bay_intervals_bay_until
    ON bay_intervals (bay_id, until);
"""


@dataclass(frozen=True)
class OccupancyInterval:
    """One bay-occupancy episode; ``until`` is None while still open."""

    id: int
    bay_id: int
    map_version: str
    state: int
    since: str
    until: str | None
    confidence: float | None
    open_frame_id: int
    close_frame_id: int | None


def _utcnow() -> datetime:
    return datetime.now(UTC)


class OccupancyRecorder:
    """Persists confirmed bay-state transitions as occupancy intervals."""

    def __init__(
        self,
        db_path: str,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._clock = clock or _utcnow
        # All writes run on the event-loop thread; cross-thread access exists
        # only for tests reading the file directly.
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.executescript(_SCHEMA)
        self._conn.commit()

    def record(
        self,
        events: Sequence[dict[str, Any]],
        map_version: str,
        frame_id: int,
    ) -> int:
        """Apply one batch of validated transitions; return rows written.

        Events are applied in order; each gets its own clock reading so a
        batch spanning multiple bays keeps distinct ``since``/``until``
        values under an injected (or real) clock.
        """
        written = 0
        for event in events:
            timestamp = self._clock().isoformat()
            bay_id = event["bayId"]
            if event["occupied"]:
                open_row = self._conn.execute(
                    "SELECT id FROM bay_intervals WHERE bay_id = ? AND until IS NULL",
                    (bay_id,),
                ).fetchone()
                if open_row is not None:
                    continue  # already open — idempotent, no fabricated history
                confidence = event.get("confidence")
                self._conn.execute(
                    """
                    INSERT INTO bay_intervals
                        (bay_id, map_version, state, since, until, confidence,
                         open_frame_id, close_frame_id)
                    VALUES (?, ?, 1, ?, NULL, ?, ?, NULL)
                    """,
                    (bay_id, map_version, timestamp, confidence, frame_id),
                )
                written += 1
            else:
                open_row = self._conn.execute(
                    "SELECT id FROM bay_intervals WHERE bay_id = ? AND until IS NULL",
                    (bay_id,),
                ).fetchone()
                if open_row is None:
                    continue  # nothing open — empty→empty, nothing to close
                self._conn.execute(
                    """
                    UPDATE bay_intervals
                    SET until = ?, close_frame_id = ?
                    WHERE id = ?
                    """,
                    (timestamp, frame_id, open_row[0]),
                )
                written += 1
        self._conn.commit()
        return written

    def intervals(self, bay_id: int | None = None) -> list[OccupancyInterval]:
        """Read intervals back (all bays, or one bay), ordered by ``since``."""
        if bay_id is None:
            rows: Iterable[Any] = self._conn.execute(
                """
                SELECT id, bay_id, map_version, state, since, until, confidence,
                       open_frame_id, close_frame_id
                FROM bay_intervals ORDER BY since, id
                """
            )
        else:
            rows = self._conn.execute(
                """
                SELECT id, bay_id, map_version, state, since, until, confidence,
                       open_frame_id, close_frame_id
                FROM bay_intervals WHERE bay_id = ? ORDER BY since, id
                """,
                (bay_id,),
            )
        return [OccupancyInterval(*row) for row in rows]

    def close(self) -> None:
        """Flush and close the database (called on service shutdown)."""
        self._conn.commit()
        self._conn.close()
