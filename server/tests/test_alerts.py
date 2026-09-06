"""Alert rules engine unit tests (bead rzo.5) — pure logic, injectable clock.

The engine sweeps occupancy intervals and derives alert candidates; the
store dedups. These tests pin the rule semantics: per-bay dwell windows as
data, closed episodes still count, and after-hours covers midnight wraps.
"""

from __future__ import annotations

from datetime import datetime

import pytest

from app.alerts import (
    ActiveHours,
    AlertCandidate,
    AlertRules,
    AlertRulesError,
    evaluate_intervals,
    rules_from_data,
)
from app.recorder import OccupancyInterval

NOW = datetime.fromisoformat("2026-09-06T14:00:00+00:00")


def interval(
    interval_id: int,
    bay_id: int,
    since: str,
    until: str | None,
    map_version: str = "feedface",
) -> OccupancyInterval:
    return OccupancyInterval(
        id=interval_id,
        bay_id=bay_id,
        map_version=map_version,
        state=1,
        since=since,
        until=until,
        confidence=0.9,
        open_frame_id=1,
        close_frame_id=None if until is None else 2,
    )


class TestRulesData:
    def test_defaults(self) -> None:
        rules = rules_from_data({})
        assert rules.dwell_minutes == 240
        assert rules.dwell_minutes_by_bay == {}
        assert rules.active_hours == ActiveHours(6, 22)

    def test_per_bay_overrides(self) -> None:
        rules = rules_from_data({"dwellMinutesByBay": {"0": 90, 2: 30}})
        assert rules.dwell_window(0) == 90
        assert rules.dwell_window(2) == 30
        assert rules.dwell_window(1) == 240  # default

    def test_malformed_raises(self) -> None:
        with pytest.raises(AlertRulesError):
            rules_from_data([1, 2])
        with pytest.raises(AlertRulesError):
            rules_from_data({"dwellMinutes": 0})
        with pytest.raises(AlertRulesError):
            rules_from_data({"dwellMinutesByBay": {"x": 10}})
        with pytest.raises(AlertRulesError):
            rules_from_data({"dwellMinutesByBay": {"0": -5}})
        with pytest.raises(AlertRulesError):
            rules_from_data({"activeHours": {"startHour": 24}})
        with pytest.raises(AlertRulesError):
            rules_from_data({"activeHours": {"startHour": 8, "endHour": 8}})

    def test_active_hours_contains(self) -> None:
        window = ActiveHours(6, 22)
        assert window.contains(datetime.fromisoformat("2026-09-06T06:00:00+00:00"))
        assert window.contains(datetime.fromisoformat("2026-09-06T21:59:00+00:00"))
        assert not window.contains(datetime.fromisoformat("2026-09-06T22:00:00+00:00"))
        assert not window.contains(datetime.fromisoformat("2026-09-06T05:59:00+00:00"))

    def test_active_hours_midnight_wrap(self) -> None:
        window = ActiveHours(20, 6)  # overnight shift
        assert window.contains(datetime.fromisoformat("2026-09-06T23:00:00+00:00"))
        assert window.contains(datetime.fromisoformat("2026-09-06T02:00:00+00:00"))
        assert not window.contains(datetime.fromisoformat("2026-09-06T12:00:00+00:00"))


class TestEvaluateIntervals:
    def test_open_episode_inside_dwell_window_is_quiet(self) -> None:
        rules = AlertRules(dwell_minutes=240)
        opened = "2026-09-06T13:00:00+00:00"  # 1h open, window 4h
        assert evaluate_intervals([interval(1, 0, opened, None)], rules, NOW) == []

    def test_open_episode_past_dwell_window_flags_overstay(self) -> None:
        rules = AlertRules(dwell_minutes=120)
        opened = "2026-09-06T10:00:00+00:00"  # 4h open
        [candidate] = evaluate_intervals([interval(1, 0, opened, None)], rules, NOW)
        assert candidate.bay_id == 0
        assert candidate.rule == "overstay"
        assert candidate.interval_id == 1
        assert candidate.since == opened
        assert candidate.detail == {
            "dwellMinutes": 120,
            "elapsedMinutes": 240.0,
            "stillOpen": True,
        }

    def test_per_bay_dwell_window(self) -> None:
        rules = rules_from_data({"dwellMinutes": 240, "dwellMinutesByBay": {3: 30}})
        opened = "2026-09-06T13:00:00+00:00"  # 1h open: past bay 3's 30-min window
        [candidate] = evaluate_intervals([interval(1, 3, opened, None)], rules, NOW)
        assert candidate.rule == "overstay"
        assert candidate.detail["dwellMinutes"] == 30

    def test_closed_episode_accrues_until_close(self) -> None:
        rules = AlertRules(dwell_minutes=120)
        # Opened 10:00, closed 11:30 → 90 minutes, under the window: quiet.
        assert (
            evaluate_intervals(
                [interval(1, 0, "2026-09-06T10:00:00+00:00", "2026-09-06T11:30:00+00:00")],
                rules,
                NOW,
            )
            == []
        )
        # Opened 10:00, closed 12:30 → 150 minutes: overstay, stillOpen=False.
        [candidate] = evaluate_intervals(
            [interval(2, 0, "2026-09-06T10:00:00+00:00", "2026-09-06T12:30:00+00:00")],
            rules,
            NOW,
        )
        assert candidate.rule == "overstay"
        assert candidate.detail["stillOpen"] is False

    def test_episode_opened_outside_active_hours_flags_after_hours(self) -> None:
        rules = AlertRules()  # active 06:00–22:00 UTC
        overnight = interval(1, 2, "2026-09-06T03:15:00+00:00", "2026-09-06T04:00:00+00:00")
        [candidate] = evaluate_intervals([overnight], rules, NOW)
        assert candidate.rule == "afterHours"
        assert candidate.bay_id == 2
        assert candidate.detail == {
            "activeHours": {"startHour": 6, "endHour": 22},
            "openedAt": "2026-09-06T03:15:00+00:00",
        }

    def test_both_rules_can_fire_on_one_episode(self) -> None:
        rules = rules_from_data(
            {"dwellMinutes": 60, "activeHours": {"startHour": 6, "endHour": 12}}
        )
        episode = interval(1, 0, "2026-09-06T04:00:00+00:00", None)  # 10h open, opened at 04:00
        candidates = evaluate_intervals([episode], rules, NOW)
        assert sorted(c.rule for c in candidates) == ["afterHours", "overstay"]

    def test_one_candidate_per_rule_per_episode(self) -> None:
        rules = AlertRules(dwell_minutes=10)
        candidates = evaluate_intervals(
            [interval(1, 0, "2026-09-06T08:00:00+00:00", None)],
            rules,
            NOW,
        )
        assert len(candidates) == 1  # sweep is idempotent-shaped: single candidate


def test_candidate_is_frozen_data() -> None:
    candidate = AlertCandidate(
        bay_id=0,
        rule="overstay",
        interval_id=1,
        map_version="feedface",
        since="2026-09-06T08:00:00+00:00",
        detail={},
    )
    with pytest.raises(Exception):  # noqa: B017 - frozen dataclass raises FrozenInstanceError
        candidate.bay_id = 5  # type: ignore[misc]
