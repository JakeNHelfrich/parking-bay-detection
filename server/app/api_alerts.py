"""REST surface for the durable alert record (bead rzo.5).

Read + acknowledge over HTTP — any client (the in-app notification area, a
supervisor's browser, a webhook consumer) sees the same durable alerts the
WebSocket path raises. Listing performs a rules sweep first, so an overstay
that has ripened since the last ``bayState`` batch materializes the moment
someone looks, without any background timer or protocol change. Delivery out
of the app (webhook) is fire-and-forget at raise time — see ``app/webhook.py``.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request

from app.alert_store import AlertStore, StoredAlert
from app.alerts import AlertRules, evaluate_intervals
from app.recorder import OccupancyRecorder
from app.schemas import AlertAckResponse, AlertOut, AlertsResponse

router = APIRouter(prefix="/api/alerts", tags=["alerts"])


def _parts(request: Request) -> tuple[OccupancyRecorder, AlertStore, AlertRules]:
    recorder: OccupancyRecorder | None = getattr(request.app.state, "recorder", None)
    store: AlertStore | None = getattr(request.app.state, "alert_store", None)
    rules: AlertRules | None = getattr(request.app.state, "alert_rules", None)
    if recorder is None or store is None or rules is None:
        raise HTTPException(status_code=503, detail="alert store unavailable; see /health")
    return recorder, store, rules


@router.get("")
def list_alerts(
    request: Request,
    unacknowledged: Annotated[bool, Query()] = False,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> AlertsResponse:
    """Alerts, newest first (optionally only unacknowledged ones).

    A sweep runs before the read: open episodes past their dwell window and
    episodes opened outside active hours become alerts here even if no
    ``bayState`` batch has arrived since they ripened.
    """
    recorder, store, rules = _parts(request)
    sweep(recorder, store, rules)  # materialize ripened alerts before listing
    return AlertsResponse(
        alerts=[
            AlertOut(
                id=alert.id,
                bayId=alert.bay_id,
                rule=alert.rule,
                since=alert.since,
                raisedAt=alert.raised_at,
                acknowledged=alert.acknowledged,
                detail=alert.detail,
            )
            for alert in store.list(unacknowledged_only=unacknowledged, limit=limit)
        ]
    )


@router.post("/{alert_id}/ack")
def acknowledge_alert(request: Request, alert_id: int) -> AlertAckResponse:
    """Acknowledge one alert (the in-app notification area's dismiss)."""
    _recorder, store, _rules = _parts(request)
    if not store.acknowledge(alert_id):
        raise HTTPException(status_code=404, detail=f"alert {alert_id} not found")
    return AlertAckResponse(id=alert_id, acknowledged=True)


def sweep(recorder: OccupancyRecorder, store: AlertStore, rules: AlertRules) -> list[StoredAlert]:
    """Evaluate the rules over the current record; persist new alerts.

    Shared by the REST listing and the ``bayState`` path, so both raise the
    same derived alerts exactly once (the store dedups); the return value is
    the alerts that are genuinely new (drives webhook delivery).
    """
    candidates = evaluate_intervals(recorder.intervals(), rules, datetime.now(UTC))
    return store.raise_new(candidates)
