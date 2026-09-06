"""Pydantic schemas for the read-only history REST API (bead rzo.3).

These are the JSON contracts for ``/api/history`` endpoints — shareable by
any client, not just the live WebSocket. Field naming matches the wire
convention used elsewhere (camelCase). Timestamps are ISO 8601 UTC strings;
durations are seconds (float, rounded by the router). No pixels exist
anywhere in this surface.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class HistoryIntervalOut(BaseModel):
    """One occupancy episode within a queried bay timeline."""

    id: int
    bayId: int
    mapVersion: str
    since: str
    until: str | None
    open: bool
    durationSeconds: float
    confidence: float | None
    openFrameId: int
    closeFrameId: int | None


class BayTimelineResponse(BaseModel):
    """Timeline of a single bay over ``[from, to)``."""

    bayId: int
    from_: str = Field(serialization_alias="from", validation_alias="from")
    to: str
    intervals: list[HistoryIntervalOut]


class OpenEpisodeOut(BaseModel):
    """The episode still open at query time, if any."""

    since: str
    durationSeconds: float
    mapVersion: str
    confidence: float | None


class BayDwellSummaryOut(BaseModel):
    """Per-bay dwell statistics over a window (episodes clipped to it)."""

    bayId: int
    episodes: int
    totalSeconds: float
    meanSeconds: float
    maxSeconds: float
    open: OpenEpisodeOut | None


class DwellResponse(BaseModel):
    """Dwell summaries for all bays seen in the window."""

    from_: str = Field(serialization_alias="from", validation_alias="from")
    to: str
    bays: list[BayDwellSummaryOut]


class BayRollupOut(BaseModel):
    """One bay's occupied time within one rollup bucket."""

    bayId: int
    occupiedSeconds: float
    episodes: int


class BucketRollupOut(BaseModel):
    """One bucket of the rollup: occupied seconds per bay."""

    start: str
    end: str
    bays: list[BayRollupOut]


class RollupsResponse(BaseModel):
    """Day or shift rollups over the window."""

    granularity: str
    from_: str = Field(serialization_alias="from", validation_alias="from")
    to: str
    buckets: list[BucketRollupOut]
