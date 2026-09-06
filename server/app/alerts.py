"""Alert rules engine (bead rzo.5) — pure logic over the occupancy record.

Rules are *data*: thresholds (per-bay dwell windows, active hours) live in
``alert_rules.json`` (path overridable via ``PARKING_ALERT_RULES``), never in
code. Bay identity is the stable ``bayId`` (invariant 5); rules only ever read
what the frontend reported — they never re-derive occupancy.

Evaluation is a **sweep** over intervals rather than a timer: every call
re-derives which alerts the record implies *now* (open episodes accrue toward
their dwell window; an episode opened outside active hours flags overnight
activity even after it closes). The caller sweeps on each ``bayState`` batch
and before listing alerts, so an overstay materializes without any protocol
change or background task. Deduplication is the store's job (unique
``(rule, interval_id)``), which makes the sweep idempotent.

Two rules cover the bead's three conditions:

- ``overstay`` — bay occupied (or was occupied) longer than its dwell window.
  This is the "blocked bay / truck that never leaves" condition: a bay is
  unavailable past its expected turnover time. The per-bay dwell window is
  config data (``dwellMinutesByBay`` over ``dwellMinutes``), not code.
- ``afterHours`` — an episode opened outside the configured active hours
  (overnight/weekend activity).

Injectable clock; no I/O, no FastAPI, no SQLite imports.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

# Re-used record type: anything with the interval fields the recorder emits.
from app.recorder import OccupancyInterval

RULE_OVERSTAY = "overstay"
RULE_AFTER_HOURS = "afterHours"


class AlertRulesError(ValueError):
    """Raised when the alert-rules data file is malformed."""


@dataclass(frozen=True)
class ActiveHours:
    """Daily window in which yard activity is expected (UTC)."""

    start_hour: int
    end_hour: int

    def contains(self, moment: datetime) -> bool:
        """True when ``moment``'s UTC wall time falls inside ``[start, end)``.

        A window wrapping midnight (start > end, e.g. 20 → 06) is supported.
        """
        hour = moment.astimezone(UTC).hour
        if self.start_hour <= self.end_hour:
            return self.start_hour <= hour < self.end_hour
        return hour >= self.start_hour or hour < self.end_hour


@dataclass(frozen=True)
class AlertRules:
    """Alert thresholds as data (loaded from ``alert_rules.json``)."""

    dwell_minutes: int = 240
    dwell_minutes_by_bay: dict[int, int] = field(default_factory=dict)
    active_hours: ActiveHours = ActiveHours(6, 22)

    def dwell_window(self, bay_id: int) -> int:
        """Per-bay dwell window in minutes, falling back to the default."""
        return self.dwell_minutes_by_bay.get(bay_id, self.dwell_minutes)


@dataclass(frozen=True)
class AlertCandidate:
    """An alert the sweep derived; the store decides if it is new."""

    bay_id: int
    rule: str
    interval_id: int
    map_version: str
    # Opening time of the episode that triggered the alert (ISO 8601 UTC).
    since: str
    detail: dict[str, object]


def load_rules(path: str) -> AlertRules:
    """Load rules from a JSON file; a missing file means built-in defaults.

    Malformed content raises ``AlertRulesError`` so startup can surface the
    bad configuration via /health instead of silently mis-alerting.
    """
    file = Path(path)
    if not file.is_file():
        return AlertRules()
    try:
        raw = json.loads(file.read_text())
    except ValueError as exc:
        raise AlertRulesError(f"alert rules {path} is not valid JSON: {exc}") from exc
    return rules_from_data(raw, source=path)


def rules_from_data(raw: object, source: str = "alert rules") -> AlertRules:
    """Validate an already-parsed rules document into ``AlertRules``."""
    if not isinstance(raw, dict):
        raise AlertRulesError(f"{source} must be a JSON object")
    errors: list[str] = []

    dwell_minutes = raw.get("dwellMinutes", 240)
    if not isinstance(dwell_minutes, int) or isinstance(dwell_minutes, bool) or dwell_minutes <= 0:
        errors.append("dwellMinutes must be a positive integer")

    by_bay_raw = raw.get("dwellMinutesByBay", {})
    by_bay: dict[int, int] = {}
    if not isinstance(by_bay_raw, dict):
        errors.append("dwellMinutesByBay must be an object keyed by bay id")
    else:
        for key, value in by_bay_raw.items():
            bay_id = key if isinstance(key, int) else None
            if isinstance(key, str) and key.isdigit():
                bay_id = int(key)
            if (
                bay_id is None
                or bay_id < 0
                or not isinstance(value, int)
                or isinstance(value, bool)
                or value <= 0
            ):
                errors.append(f"dwellMinutesByBay[{key!r}] must map a bay id to positive minutes")
            else:
                by_bay[bay_id] = value

    hours_raw = raw.get("activeHours", {})
    active_hours = ActiveHours(6, 22)
    if not isinstance(hours_raw, dict):
        errors.append("activeHours must be an object with startHour and endHour")
    else:
        start = hours_raw.get("startHour", 6)
        end = hours_raw.get("endHour", 22)
        if not isinstance(start, int) or isinstance(start, bool) or not 0 <= start <= 23:
            errors.append("activeHours.startHour must be an hour 0..23")
        elif not isinstance(end, int) or isinstance(end, bool) or not 0 <= end <= 24:
            errors.append("activeHours.endHour must be an hour 0..24")
        elif start == end:
            errors.append("activeHours.startHour and endHour must differ")
        else:
            active_hours = ActiveHours(start, end)

    if errors:
        raise AlertRulesError(f"{source}: " + "; ".join(errors))
    return AlertRules(
        dwell_minutes=dwell_minutes,
        dwell_minutes_by_bay=by_bay,
        active_hours=active_hours,
    )


def evaluate_intervals(
    intervals: list[OccupancyInterval],
    rules: AlertRules,
    now: datetime,
) -> list[AlertCandidate]:
    """Derive the alerts the record implies at ``now`` (dedup happens later).

    One candidate per (rule, episode) at most; episodes that already closed
    still yield candidates — a truck that stayed overnight and left at dawn
    still deserves the overnight alert, and the store's unique constraint
    makes re-raising the same episode a no-op.
    """
    candidates: list[AlertCandidate] = []
    for interval in intervals:
        since = _parse(interval.since)
        for candidate in _evaluate_one(interval, since, rules, now):
            candidates.append(candidate)
    return candidates


def _evaluate_one(
    interval: OccupancyInterval,
    since: datetime,
    rules: AlertRules,
    now: datetime,
) -> list[AlertCandidate]:
    candidates: list[AlertCandidate] = []
    if not rules.active_hours.contains(since):
        candidates.append(
            AlertCandidate(
                bay_id=interval.bay_id,
                rule=RULE_AFTER_HOURS,
                interval_id=interval.id,
                map_version=interval.map_version,
                since=interval.since,
                detail={
                    "activeHours": {
                        "startHour": rules.active_hours.start_hour,
                        "endHour": rules.active_hours.end_hour,
                    },
                    "openedAt": interval.since,
                },
            )
        )

    end = _parse(interval.until) if interval.until is not None else now
    elapsed_minutes = (end - since).total_seconds() / 60.0
    dwell = rules.dwell_window(interval.bay_id)
    if elapsed_minutes > dwell:
        candidates.append(
            AlertCandidate(
                bay_id=interval.bay_id,
                rule=RULE_OVERSTAY,
                interval_id=interval.id,
                map_version=interval.map_version,
                since=interval.since,
                detail={
                    "dwellMinutes": dwell,
                    "elapsedMinutes": round(elapsed_minutes, 1),
                    "stillOpen": interval.until is None,
                },
            )
        )
    return candidates


def _parse(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        # Recorder timestamps are always UTC ISO 8601; a naive value can only
        # come from a hand-edited database — treat it as UTC rather than crash.
        return parsed.replace(tzinfo=UTC)
    return parsed
