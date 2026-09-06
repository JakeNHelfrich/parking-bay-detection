"""Pure history aggregation over the occupancy record — bead rzo.3.

Read-only math over ``OccupancyInterval`` rows: window parsing, per-bay
timelines, dwell summaries, and day/shift rollups. No FastAPI here — the
router in ``app/api_history.py`` adapts these results to pydantic schemas
(``app/schemas.py``). The store only ever holds occupancy episodes (bay id,
state, timestamps, confidence, bay-map version); no pixels are ever stored
or processed by any of this.

Time convention: all timestamps are timezone-aware UTC. Naive query
parameters are rejected by the router (ambiguous); values from the record
are always stored aware. Windows are half-open ``[from, to)``.

Overlap rule used throughout: an episode ``[since, until)`` overlaps a
window when ``since < window.to`` and ``until is None or until >
window.from`` (open episodes still running at query time count, with their
``until`` clamped to the window end for duration math).

Durations are returned in seconds (float). Dwell stats clip each episode to
the queried window; timeline entries report the episode's full duration as
known at query time (open episodes: elapsed so far).
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from app.recorder import OccupancyInterval

SECONDS_PER_HOUR = 3600.0


class HistoryRangeError(ValueError):
    """A caller-supplied time range or bucketing parameter is invalid."""


@dataclass(frozen=True)
class Window:
    """Half-open query window ``[start, end)``, aware UTC."""

    start: datetime
    end: datetime


@dataclass(frozen=True)
class Bucket:
    """One rollup bucket ``[start, end)`` within the window."""

    start: datetime
    end: datetime


@dataclass(frozen=True)
class TimelineEntry:
    """One occupancy episode as rendered for the timeline of a bay."""

    interval: OccupancyInterval
    open: bool
    # Full episode duration as known at query time; open episodes report
    # elapsed so far (since → window end).
    duration_seconds: float


@dataclass(frozen=True)
class OpenEpisode:
    """The episode still open at query time, if any."""

    since: str
    duration_seconds: float
    map_version: str
    confidence: float | None


@dataclass(frozen=True)
class DwellSummary:
    """Per-bay dwell statistics over a window (episodes clipped to it)."""

    bay_id: int
    episodes: int
    total_seconds: float
    mean_seconds: float
    max_seconds: float
    open_episode: OpenEpisode | None


@dataclass(frozen=True)
class BucketBayRollup:
    """One bay's occupied time within one bucket."""

    bay_id: int
    occupied_seconds: float
    episodes: int


@dataclass(frozen=True)
class BucketRollup:
    """One bucket of the rollup: occupied seconds per bay."""

    start: datetime
    end: datetime
    bays: list[BucketBayRollup]


def parse_timestamp(value: str, *, field: str) -> datetime:
    """Parse an ISO 8601 timestamp; naive values are rejected as ambiguous."""
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise HistoryRangeError(f"{field} is not a valid ISO 8601 timestamp: {value!r}") from exc
    if parsed.tzinfo is None:
        raise HistoryRangeError(
            f"{field} must be timezone-aware (got naive {value!r}; if the UTC offset's"
            " '+' was lost in transit, URL-encode the timestamp, e.g. %2B00:00)"
        )
    return parsed.astimezone(UTC)


def parse_window(from_value: str, to_value: str) -> Window:
    """Parse a ``[from, to)`` window; ``from`` must precede ``to``."""
    start = parse_timestamp(from_value, field="from")
    end = parse_timestamp(to_value, field="to")
    if start >= end:
        raise HistoryRangeError("from must be earlier than to")
    return Window(start=start, end=end)


def overlaps(since: datetime, until: datetime | None, window: Window) -> bool:
    """Whether episode ``[since, until)`` overlaps the window."""
    return since < window.end and (until is None or until > window.start)


def overlap_seconds(since: datetime, until: datetime | None, window: Window) -> float:
    """Seconds of ``[since, until)`` inside the window (0 if none).

    Open episodes are clamped to the window end — the truck is presumably
    still there, and its dwell accrues until ``to``.
    """
    if not overlaps(since, until, window):
        return 0.0
    start = max(since, window.start)
    end = min(until, window.end) if until is not None else window.end
    return (end - start).total_seconds()


def filter_intervals(intervals: list[OccupancyInterval], window: Window) -> list[OccupancyInterval]:
    """Episodes overlapping the window, in stored order (since, id)."""
    return [
        interval
        for interval in intervals
        if overlaps(_parse_stored(interval.since), _parse_stored(interval.until), window)
    ]


def _parse_stored(value: str | None) -> datetime | None:
    """Parse a timestamp as stored by the recorder (always aware UTC)."""
    if value is None:
        return None
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:  # defensive: the record always stores aware
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def build_timeline(intervals: list[OccupancyInterval], window: Window) -> list[TimelineEntry]:
    """Timeline entries for episodes overlapping the window, in stored order."""
    entries: list[TimelineEntry] = []
    for interval in intervals:
        since = _parse_stored(interval.since)
        until = _parse_stored(interval.until)
        if since is None or not overlaps(since, until, window):
            continue
        # Episode duration as known now: open episodes run to the window end.
        end = until if until is not None else window.end
        entries.append(
            TimelineEntry(
                interval=interval,
                open=until is None,
                duration_seconds=max(0.0, (end - since).total_seconds()),
            )
        )
    return entries


def dwell_summaries(intervals: list[OccupancyInterval], window: Window) -> list[DwellSummary]:
    """Per-bay dwell statistics over the window, sorted by bay id.

    Completed episodes are clipped to the window; an episode still open at
    query time is reported separately per bay (its dwell accrues to the
    window end and it is also counted in ``episodes``/``total_seconds``).
    """
    by_bay: dict[int, list[OccupancyInterval]] = {}
    for interval in filter_intervals(intervals, window):
        by_bay.setdefault(interval.bay_id, []).append(interval)

    summaries: list[DwellSummary] = []
    for bay_id in sorted(by_bay):
        durations = [
            overlap_seconds(_parse_stored(i.since), _parse_stored(i.until), window)
            for i in by_bay[bay_id]
        ]
        open_rows = [i for i in by_bay[bay_id] if i.until is None]
        open_episode: OpenEpisode | None = None
        if open_rows:
            # At most one open episode per bay is guaranteed by the recorder.
            row = open_rows[-1]
            open_episode = OpenEpisode(
                since=row.since,
                duration_seconds=overlap_seconds(_parse_stored(row.since), None, window),
                map_version=row.map_version,
                confidence=row.confidence,
            )
        total = sum(durations)
        summaries.append(
            DwellSummary(
                bay_id=bay_id,
                episodes=len(by_bay[bay_id]),
                total_seconds=total,
                mean_seconds=total / len(durations),
                max_seconds=max(durations),
                open_episode=open_episode,
            )
        )
    return summaries


def day_buckets(window: Window) -> list[Bucket]:
    """UTC calendar-day buckets covering the window (first/last clipped)."""
    day = window.start.astimezone(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    buckets: list[Bucket] = []
    while day < window.end:
        bucket_end = day + timedelta(days=1)
        buckets.append(Bucket(start=max(day, window.start), end=min(bucket_end, window.end)))
        day = bucket_end
    return buckets


def shift_buckets(window: Window, shift_start_hour: int, shift_hours: int) -> list[Bucket]:
    """Fixed-length shift buckets aligned to ``shift_start_hour`` UTC.

    Boundaries repeat every ``shift_hours`` (e.g. start 6h / length 12h →
    06:00–18:00–06:00). Edge buckets are clipped to the window.
    """
    if not 0 <= shift_start_hour <= 23:
        raise HistoryRangeError("shiftStartHour must be within 0..23")
    if not 1 <= shift_hours <= 24:
        raise HistoryRangeError("shiftHours must be within 1..24")
    shift = timedelta(hours=shift_hours)
    day_start = window.start.astimezone(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    first = day_start + timedelta(hours=shift_start_hour)
    # Land on the newest boundary at or before the window start: walk back
    # while overshot, then forward while a whole shift still fits before it.
    while first > window.start:
        first -= shift
    while first + shift <= window.start:
        first += shift
    buckets: list[Bucket] = []
    while first < window.end:
        bucket_end = first + shift
        buckets.append(Bucket(start=max(first, window.start), end=min(bucket_end, window.end)))
        first = bucket_end
    return buckets


def rollup(intervals: list[OccupancyInterval], buckets: list[Bucket]) -> list[BucketRollup]:
    """Occupied seconds and episode counts per bay within each bucket.

    Episodes are credited to every bucket they overlap, pro-rated by the
    overlap — a truck parked across a shift boundary contributes time to
    both shifts. Only bays with positive occupied time appear.
    """
    parsed = [(_parse_stored(i.since), _parse_stored(i.until), i.bay_id) for i in intervals]
    rollups: list[BucketRollup] = []
    for bucket in buckets:
        per_bay: dict[int, BucketBayRollup] = {}
        for since, until, bay_id in parsed:
            if since is None:
                continue
            seconds = overlap_seconds(since, until, Window(start=bucket.start, end=bucket.end))
            if seconds <= 0.0:
                continue
            entry = per_bay.get(bay_id)
            if entry is None:
                per_bay[bay_id] = BucketBayRollup(
                    bay_id=bay_id, occupied_seconds=seconds, episodes=1
                )
            else:
                # dataclass frozen → rebuild with accumulated values.
                per_bay[bay_id] = BucketBayRollup(
                    bay_id=bay_id,
                    occupied_seconds=entry.occupied_seconds + seconds,
                    episodes=entry.episodes + 1,
                )
        rollups.append(
            BucketRollup(
                start=bucket.start,
                end=bucket.end,
                bays=[per_bay[bay_id] for bay_id in sorted(per_bay)],
            )
        )
    return rollups


def iter_bucket_starts(buckets: list[Bucket]) -> Iterator[datetime]:
    """Bucket starts in order (small helper for tests/serializers)."""
    for bucket in buckets:
        yield bucket.start
