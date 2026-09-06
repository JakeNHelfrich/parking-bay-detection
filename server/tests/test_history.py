"""Pure aggregation tests for the history API (bead rzo.3).

No FastAPI, no HTTP: ``app/history.py`` math over constructed
``OccupancyInterval`` rows with a fixed window, so every duration and
bucket boundary is exact.
"""

from __future__ import annotations

from datetime import datetime

import pytest

from app import history
from app.recorder import OccupancyInterval

W0 = "2026-09-06T06:00:00+00:00"
W1 = "2026-09-06T18:00:00+00:00"
WINDOW = history.parse_window(W0, W1)


def ts(value: str) -> datetime:
    return datetime.fromisoformat(value)


def interval(
    interval_id: int,
    bay_id: int,
    since: str,
    until: str | None,
    map_version: str = "mapv1",
    confidence: float | None = None,
) -> OccupancyInterval:
    return OccupancyInterval(
        id=interval_id,
        bay_id=bay_id,
        map_version=map_version,
        state=1,
        since=since,
        until=until,
        confidence=confidence,
        open_frame_id=interval_id * 10,
        close_frame_id=None if until is None else interval_id * 10 + 1,
    )


class TestWindowParsing:
    def test_parse_valid_window(self) -> None:
        window = history.parse_window(W0, W1)
        assert window.start == ts(W0)
        assert window.end == ts(W1)

    def test_naive_timestamp_rejected(self) -> None:
        with pytest.raises(history.HistoryRangeError, match="timezone-aware"):
            history.parse_window("2026-09-06T06:00:00", W1)

    def test_invalid_timestamp_rejected(self) -> None:
        with pytest.raises(history.HistoryRangeError, match="not a valid"):
            history.parse_window("yesterday", W1)

    def test_inverted_window_rejected(self) -> None:
        with pytest.raises(history.HistoryRangeError, match="earlier than"):
            history.parse_window(W1, W0)

    def test_other_timezones_are_normalized_to_utc(self) -> None:
        window = history.parse_window("2026-09-06T08:00:00+02:00", "2026-09-06T20:00:00+02:00")
        assert window.start == ts(W0)
        assert window.end == ts(W1)


class TestOverlap:
    def test_episode_inside_window(self) -> None:
        assert history.overlap_seconds(ts(W0), ts("2026-09-06T08:00:00+00:00"), WINDOW) == 7200.0

    def test_episode_straddling_window_start(self) -> None:
        seconds = history.overlap_seconds(ts("2026-09-06T04:00:00+00:00"), ts(W1), WINDOW)
        assert seconds == 12 * 3600.0

    def test_episode_spanning_whole_window(self) -> None:
        seconds = history.overlap_seconds(
            ts("2026-09-05T00:00:00+00:00"), ts("2026-09-07T00:00:00+00:00"), WINDOW
        )
        assert seconds == 12 * 3600.0

    def test_open_episode_clamped_to_window_end(self) -> None:
        assert history.overlap_seconds(ts("2026-09-06T10:00:00+00:00"), None, WINDOW) == 8 * 3600.0

    def test_episode_entirely_outside_window_is_zero(self) -> None:
        before = history.overlap_seconds(
            ts("2026-09-06T00:00:00+00:00"), ts("2026-09-06T05:00:00+00:00"), WINDOW
        )
        after = history.overlap_seconds(ts(W1), ts("2026-09-06T20:00:00+00:00"), WINDOW)
        assert before == 0.0
        assert after == 0.0

    def test_overlap_open_episode_before_window(self) -> None:
        """Still open but started before the window: counts from window start."""
        assert history.overlap_seconds(ts("2026-09-06T01:00:00+00:00"), None, WINDOW) == 12 * 3600.0


class TestBuildTimeline:
    def test_entries_in_stored_order_with_open_flag(self) -> None:
        rows = [
            interval(1, 0, "2026-09-06T07:00:00+00:00", "2026-09-06T08:30:00+00:00"),
            interval(2, 0, "2026-09-06T10:00:00+00:00", None),
            interval(3, 0, "2026-09-06T00:00:00+00:00", "2026-09-06T02:00:00+00:00"),  # outside
        ]
        entries = history.build_timeline(rows, WINDOW)
        assert [e.interval.id for e in entries] == [1, 2]
        assert entries[0].open is False
        assert entries[0].duration_seconds == 5400.0
        assert entries[1].open is True
        # Open episode reports elapsed to window end.
        assert entries[1].duration_seconds == 8 * 3600.0

    def test_empty_when_bay_was_never_occupied(self) -> None:
        assert history.build_timeline([], WINDOW) == []


class TestDwellSummaries:
    def test_stats_per_bay_sorted_and_clipped(self) -> None:
        rows = [
            interval(1, 2, "2026-09-06T05:00:00+00:00", "2026-09-06T07:00:00+00:00"),  # 1h in win
            interval(2, 0, "2026-09-06T06:30:00+00:00", "2026-09-06T07:30:00+00:00"),  # 1h
            interval(3, 0, "2026-09-06T10:00:00+00:00", "2026-09-06T12:00:00+00:00"),  # 2h
            interval(4, 5, "2026-09-06T00:00:00+00:00", "2026-09-06T01:00:00+00:00"),  # outside
        ]
        summaries = history.dwell_summaries(rows, WINDOW)
        assert [s.bay_id for s in summaries] == [0, 2]
        bay0 = summaries[0]
        assert bay0.episodes == 2
        assert bay0.total_seconds == 3 * 3600.0
        assert bay0.mean_seconds == 1.5 * 3600.0
        assert bay0.max_seconds == 2 * 3600.0
        assert bay0.open_episode is None
        bay2 = summaries[1]
        assert bay2.total_seconds == 3600.0  # clipped at window start
        assert bay2.episodes == 1

    def test_open_episode_reported_and_counted(self) -> None:
        rows = [interval(1, 0, "2026-09-06T10:00:00+00:00", None, confidence=0.9)]
        [summary] = history.dwell_summaries(rows, WINDOW)
        assert summary.episodes == 1
        assert summary.total_seconds == 8 * 3600.0
        assert summary.open_episode is not None
        assert summary.open_episode.since == "2026-09-06T10:00:00+00:00"
        assert summary.open_episode.duration_seconds == 8 * 3600.0
        assert summary.open_episode.confidence == 0.9
        assert summary.open_episode.map_version == "mapv1"

    def test_bay_without_episodes_is_absent(self) -> None:
        assert history.dwell_summaries([], WINDOW) == []


class TestDayBuckets:
    def test_partial_first_and_last_day(self) -> None:
        window = history.parse_window("2026-09-06T23:00:00+00:00", "2026-09-08T01:00:00+00:00")
        buckets = history.day_buckets(window)
        assert len(buckets) == 3
        assert buckets[0].start == ts("2026-09-06T23:00:00+00:00")
        assert buckets[0].end == ts("2026-09-07T00:00:00+00:00")
        assert buckets[1].start == ts("2026-09-07T00:00:00+00:00")
        assert buckets[1].end == ts("2026-09-08T00:00:00+00:00")
        assert buckets[2].start == ts("2026-09-08T00:00:00+00:00")
        assert buckets[2].end == ts("2026-09-08T01:00:00+00:00")

    def test_contiguous_full_coverage(self) -> None:
        buckets = history.day_buckets(WINDOW)
        assert buckets[0].start == ts(W0)
        assert buckets[-1].end == ts(W1)
        for earlier, later in zip(buckets, buckets[1:], strict=False):
            assert earlier.end == later.start


class TestShiftBuckets:
    def test_default_six_to_eighteen_alignment(self) -> None:
        buckets = history.shift_buckets(WINDOW, shift_start_hour=6, shift_hours=12)
        assert len(buckets) == 1
        assert buckets[0].start == ts(W0)
        assert buckets[0].end == ts(W1)

    def test_window_starting_mid_shift_walks_back(self) -> None:
        """Boundaries 06:00/18:00; window starts mid-shift, so the first
        bucket is clipped to the window (like a partial first day)."""
        window = history.parse_window("2026-09-06T09:00:00+00:00", "2026-09-06T20:00:00+00:00")
        buckets = history.shift_buckets(window, shift_start_hour=6, shift_hours=12)
        assert [(b.start, b.end) for b in buckets] == [
            (ts("2026-09-06T09:00:00+00:00"), ts("2026-09-06T18:00:00+00:00")),
            (ts("2026-09-06T18:00:00+00:00"), ts("2026-09-06T20:00:00+00:00")),
        ]

    def test_eight_hour_shifts_clipped_to_window(self) -> None:
        """Boundaries at 02:00/10:00/18:00; window starts mid-shift at 06:00."""
        buckets = history.shift_buckets(WINDOW, shift_start_hour=2, shift_hours=8)
        assert [(b.start, b.end) for b in buckets] == [
            (ts(W0), ts("2026-09-06T10:00:00+00:00")),  # 02:00–10:00 clipped
            (ts("2026-09-06T10:00:00+00:00"), ts(W1)),  # 10:00–18:00 full
        ]

    def test_eight_hour_shifts_boundary_walks_forward(self) -> None:
        """Start hour 0: the newest 1h boundary before 09:40 is 09:00, not 00:00."""
        window = history.parse_window("2026-09-06T09:40:00+00:00", "2026-09-06T11:40:00+00:00")
        buckets = history.shift_buckets(window, shift_start_hour=0, shift_hours=1)
        assert [(b.start, b.end) for b in buckets] == [
            (ts("2026-09-06T09:40:00+00:00"), ts("2026-09-06T10:00:00+00:00")),
            (ts("2026-09-06T10:00:00+00:00"), ts("2026-09-06T11:00:00+00:00")),
            (ts("2026-09-06T11:00:00+00:00"), ts("2026-09-06T11:40:00+00:00")),
        ]

    def test_invalid_shift_params_raise(self) -> None:
        with pytest.raises(history.HistoryRangeError, match="shiftStartHour"):
            history.shift_buckets(WINDOW, shift_start_hour=24, shift_hours=12)
        with pytest.raises(history.HistoryRangeError, match="shiftHours"):
            history.shift_buckets(WINDOW, shift_start_hour=6, shift_hours=0)
        with pytest.raises(history.HistoryRangeError, match="shiftHours"):
            history.shift_buckets(WINDOW, shift_start_hour=6, shift_hours=25)


class TestRollup:
    def test_episode_prorated_across_shift_boundary(self) -> None:
        """A 6h episode spanning the 06:00–18:00 → 18:00–06:00 boundary."""
        rows = [interval(1, 0, "2026-09-06T16:00:00+00:00", "2026-09-06T22:00:00+00:00")]
        buckets = history.shift_buckets(
            history.parse_window("2026-09-06T12:00:00+00:00", "2026-09-07T00:00:00+00:00"),
            shift_start_hour=6,
            shift_hours=12,
        )
        rollups = history.rollup(rows, buckets)
        assert len(rollups) == 2
        # Bucket 1: 12:00–18:00 → 2h of the episode; bucket 2: 18:00–00:00 → 4h.
        assert rollups[0].bays[0].occupied_seconds == 2 * 3600.0
        assert rollups[1].bays[0].occupied_seconds == 4 * 3600.0
        assert [bay.episodes for bay in rollups[0].bays + rollups[1].bays] == [1, 1]

    def test_multi_day_episode_credited_to_each_day(self) -> None:
        rows = [interval(1, 3, "2026-09-06T23:00:00+00:00", "2026-09-08T02:00:00+00:00")]
        window = history.parse_window("2026-09-06T00:00:00+00:00", "2026-09-09T00:00:00+00:00")
        rollups = history.rollup(rows, history.day_buckets(window))
        # 3 days: 1h + 24h + 2h.
        assert [bay.occupied_seconds for r in rollups for bay in r.bays] == [
            3600.0,
            24 * 3600.0,
            2 * 3600.0,
        ]

    def test_bays_sorted_and_positive_only(self) -> None:
        rows = [
            interval(1, 7, "2026-09-06T07:00:00+00:00", "2026-09-06T08:00:00+00:00"),
            interval(2, 2, "2026-09-06T07:30:00+00:00", None),
            interval(3, 9, "2026-09-06T00:00:00+00:00", "2026-09-06T01:00:00+00:00"),  # outside
        ]
        [only] = history.day_buckets(WINDOW)
        rollups = history.rollup(rows, [only])
        assert [bay.bay_id for bay in rollups[0].bays] == [2, 7]
        assert all(bay.occupied_seconds > 0 for bay in rollups[0].bays)

    def test_empty_bucket_has_no_bays(self) -> None:
        window = history.parse_window("2026-09-06T00:00:00+00:00", "2026-09-06T03:00:00+00:00")
        rows = [interval(1, 0, "2026-09-06T10:00:00+00:00", None)]
        rollups = history.rollup(rows, history.day_buckets(window))
        assert rollups[0].bays == []
