"""Read-only REST surface over the occupancy record: /api/history.

Endpoints (all GET, all read-only — the record is written only by the
``bayState`` WebSocket path):

- ``GET /api/history/timeline/{bayId}?from=&to=`` — one bay's occupancy
  episodes over a window (the "what happened, when" view).
- ``GET /api/history/dwell?from=&to=&bayId=`` — per-bay dwell summaries
  (episodes, total/mean/max occupied time, the episode still open, if any).
- ``GET /api/history/rollups?granularity=day|shift&from=&to=&bayId=`` —
  occupied seconds per bay per day (UTC calendar) or per shift (aligned to
  ``shiftStartHour`` UTC, ``shiftHours`` long; defaults 06:00, 12h).
  Episodes spanning a bucket boundary are pro-rated across buckets.

``from``/``to`` are ISO 8601 timestamps; naive values are rejected
(ambiguous across time zones) and ``from`` must precede ``to``. Both
default to a trailing 24h window. Any HTTP client can review the record —
this is what makes history shareable beyond the live socket. Aggregation
math lives in ``app/history.py`` (pure, unit-tested); this router only
adapts it to the pydantic schemas in ``app/schemas.py``.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, Query, Request

from app import history
from app.history import Window
from app.recorder import OccupancyRecorder
from app.schemas import (
    BayDwellSummaryOut,
    BayTimelineResponse,
    BucketRollupOut,
    DwellResponse,
    HistoryIntervalOut,
    OpenEpisodeOut,
    RollupsResponse,
)

router = APIRouter(prefix="/api/history", tags=["history"])

DEFAULT_WINDOW = timedelta(hours=24)


class _RecorderUnavailable(Exception):
    """Internal: the durable record is not open; rendered as 503."""


def _iso(value: datetime) -> str:
    """ISO 8601 UTC string for wire timestamps."""
    return value.astimezone(UTC).isoformat()


def _recorder(request: Request) -> OccupancyRecorder:
    """The app's recorder; raises when the store is unavailable."""
    recorder: OccupancyRecorder | None = request.app.state.recorder
    if recorder is None:
        # Mirror the WS path: a degraded record store is a 503, not a crash.
        raise _RecorderUnavailable()
    return recorder


def _resolve_window(from_: str | None, to: str | None) -> Window:
    """Explicit window, or the trailing ``DEFAULT_WINDOW`` ending now."""
    if from_ is None and to is None:
        end = datetime.now(UTC)
        return Window(start=end - DEFAULT_WINDOW, end=end)
    if from_ is None or to is None:
        raise history.HistoryRangeError("from and to must be provided together")
    return history.parse_window(from_, to)


def _with_window(
    request: Request, from_: str | None, to: str | None
) -> tuple[Window, OccupancyRecorder]:
    """Common prologue: parse the window and fetch the recorder."""
    try:
        window = _resolve_window(from_, to)
    except history.HistoryRangeError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    try:
        return window, _recorder(request)
    except _RecorderUnavailable as exc:
        raise HTTPException(status_code=503, detail="recorder unavailable; see /health") from exc


@router.get("/timeline/{bay_id}", response_model=BayTimelineResponse)
def bay_timeline(
    request: Request,
    bay_id: Annotated[int, Path(ge=0)],
    from_: Annotated[str | None, Query(alias="from")] = None,
    to: Annotated[str | None, Query()] = None,
) -> BayTimelineResponse:
    """One bay's occupancy episodes over ``[from, to)``."""
    window, recorder = _with_window(request, from_, to)
    intervals = history.filter_intervals(recorder.intervals(bay_id), window)
    entries = history.build_timeline(intervals, window)
    return BayTimelineResponse(
        bayId=bay_id,
        **{"from": _iso(window.start)},
        to=_iso(window.end),
        intervals=[
            HistoryIntervalOut(
                id=entry.interval.id,
                bayId=entry.interval.bay_id,
                mapVersion=entry.interval.map_version,
                since=entry.interval.since,
                until=entry.interval.until,
                open=entry.open,
                durationSeconds=round(entry.duration_seconds, 1),
                confidence=entry.interval.confidence,
                openFrameId=entry.interval.open_frame_id,
                closeFrameId=entry.interval.close_frame_id,
            )
            for entry in entries
        ],
    )


@router.get("/dwell", response_model=DwellResponse)
def dwell(
    request: Request,
    bay_id: Annotated[int | None, Query(alias="bayId", ge=0)] = None,
    from_: Annotated[str | None, Query(alias="from")] = None,
    to: Annotated[str | None, Query()] = None,
) -> DwellResponse:
    """Per-bay dwell summaries over ``[from, to)`` (optionally one bay)."""
    window, recorder = _with_window(request, from_, to)
    summaries = history.dwell_summaries(recorder.intervals(bay_id), window)
    return DwellResponse(
        **{"from": _iso(window.start)},
        to=_iso(window.end),
        bays=[
            BayDwellSummaryOut(
                bayId=summary.bay_id,
                episodes=summary.episodes,
                totalSeconds=round(summary.total_seconds, 1),
                meanSeconds=round(summary.mean_seconds, 1),
                maxSeconds=round(summary.max_seconds, 1),
                open=(
                    OpenEpisodeOut(
                        since=summary.open_episode.since,
                        durationSeconds=round(summary.open_episode.duration_seconds, 1),
                        mapVersion=summary.open_episode.map_version,
                        confidence=summary.open_episode.confidence,
                    )
                    if summary.open_episode is not None
                    else None
                ),
            )
            for summary in summaries
        ],
    )


@router.get("/rollups", response_model=RollupsResponse)
def rollups(
    request: Request,
    granularity: Annotated[str, Query(pattern="^(day|shift)$")] = "day",
    bay_id: Annotated[int | None, Query(alias="bayId", ge=0)] = None,
    from_: Annotated[str | None, Query(alias="from")] = None,
    to: Annotated[str | None, Query()] = None,
    shift_start_hour: Annotated[int, Query(alias="shiftStartHour", ge=0, le=23)] = 6,
    shift_hours: Annotated[int, Query(alias="shiftHours", ge=1, le=24)] = 12,
) -> RollupsResponse:
    """Day (UTC calendar) or shift rollups of occupied time per bay."""
    window, recorder = _with_window(request, from_, to)
    try:
        buckets = (
            history.day_buckets(window)
            if granularity == "day"
            else history.shift_buckets(window, shift_start_hour, shift_hours)
        )
    except history.HistoryRangeError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    bucket_rollups = history.rollup(recorder.intervals(bay_id), buckets)
    return RollupsResponse(
        granularity=granularity,
        **{"from": _iso(window.start)},
        to=_iso(window.end),
        buckets=[
            BucketRollupOut(
                start=_iso(bucket_rollup.start),
                end=_iso(bucket_rollup.end),
                bays=[
                    {
                        "bayId": bay.bay_id,
                        "occupiedSeconds": round(bay.occupied_seconds, 1),
                        "episodes": bay.episodes,
                    }
                    for bay in bucket_rollup.bays
                ],
            )
            for bucket_rollup in bucket_rollups
        ],
    )
