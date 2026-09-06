# Parking Bay Detection

A computer-vision project that detects trucks and parking-bay occupancy in a **simulated** 3D scene.

A TypeScript + Three.js frontend renders a simulated **depot yard** — a warehouse dock wall with four far-side (north) bays, approached across a lane by rigid box trucks. Frames of the simulation are streamed to a Python FastAPI backend running a YOLO object-detection model. The backend returns bounding boxes for detected trucks, which are overlaid back onto the frontend in real time. Parking bays are then marked **FULL** or **EMPTY** based on whether a detected truck overlaps them.

## Architecture

```
┌──────────────────────────────┐         ┌───────────────────────────────┐
│  Frontend (TypeScript)       │         │  Backend (Python)             │
│  Vite + Three.js             │         │  FastAPI + Ultralytics YOLO   │
│                              │         │                               │
│  1. Render sim @ 60fps       │         │                               │
│  2. Capture canvas → JPEG    │  WS     │  3. Receive frame             │
│     (throttled ~10-15fps)  ──┼────────▶│  4. YOLOv8n inference         │
│                              │         │  5. Filter to `truck` class   │
│  7. Draw overlay boxes +     │  WS     │                               │
│     bay FULL/EMPTY state   ◀─┼─────────│  6. Emit detections JSON      │
│  8. Compute bay occupancy    │         │     (normalized bboxes)       │
│     from truck bboxes        │         │                               │
└──────────────────────────────┘         └───────────────────────────────┘
```

### Core loop design

- **Render and infer are decoupled.** The simulation renders at full frame rate and never blocks on inference. Detections arrive asynchronously and the overlay always draws the most recent result.
- **Binary WebSocket transport.** The frontend captures the render canvas to a JPEG `Blob` at a fixed capture resolution and sends it as an `ArrayBuffer`. The backend replies with a JSON message on the same socket.
- **Normalized coordinates.** Every bounding box in the wire protocol is `[x, y, w, h]` in `0..1` relative to the frame. The frontend scales boxes to the displayed canvas size, so capture resolution never leaks into overlay math.
- **Frame IDs for latency + freshness.** Each frame carries a monotonic `frameId`. The server echoes it back with `latencyMs`. The frontend drops results for frames older than the latest captured frame, so the overlay never lags behind the simulation.

### Wire protocol

**Frontend → Backend** — binary WebSocket messages (single JPEG frame), with two small text control messages:

A session header sent once to negotiate capture size (and, once the bay map has loaded, the bay-map content version used to provenance occupancy history):

```json
{ "type": "hello", "captureWidth": 960, "captureHeight": 540, "bayMapVersion": "1a2b3c4d" }
```

`bayMapVersion` is a content hash of the bay definitions (`bayMapVersion()` in `src/bays/bay-defs.ts`); it is optional, but a `bayState` batch is only recorded when the session's hello carried one — every recorded occupancy episode is stamped with it, so bay-layout changes over time never corrupt history.

A per-frame text header sent immediately before each binary JPEG, so the server can echo the frame ID:

```json
{ "type": "frame", "frameId": 412 }
```

A batched report of **confirmed** bay occupancy transitions (see below), sent only when at least one transition was confirmed by the referenced frame:

```json
{
  "type": "bayState",
  "frameId": 412,
  "events": [
    { "bayId": 0, "occupied": true, "confidence": 0.91 },
    { "bayId": 2, "occupied": false }
  ]
}
```

`frameId` identifies the detections frame that confirmed the transitions. Occupancy is derived entirely in the frontend (the one place with the bay map — invariant 5): the server only records what it is told, never recomputes it, and acknowledges each batch by echoing its `frameId`:

```json
{ "type": "bayStateAck", "frameId": 412, "accepted": 2 }
```

**Backend → Frontend** — besides `detections`, `error`, and `bayStateAck` replies, every valid `hello` is answered with the **late-joiner snapshot** (rzo.6): every currently-open occupancy episode from the durable record, so a second viewer (a supervisor pulling up the board) sees the yard's truth at connect instead of waiting for the next transition:

```json
{
  "type": "baySnapshot",
  "serverTime": "2026-09-06T12:00:00.123456+00:00",
  "bays": [
    { "bayId": 1, "since": "2026-09-06T08:00:00+00:00", "dwellSeconds": 14400.1,
      "confidence": 0.93, "mapVersion": "1a2b3c4d" }
  ]
}
```

The snapshot is a read-only projection of the record — never a re-derivation of occupancy (invariant 5) — and carries no `frameId` because hello has none. The frontend merges it into its bay-state view (recorded bays render occupied immediately); the next detections frame re-derives every bay from live video and takes over, and the merge deliberately bypasses the transition tracker so no spurious reports echo back to the server. An empty `bays` means nothing is recorded, not that the yard is empty. When the record store is degraded the reply is an `error` instead of a lying snapshot. Deeper history (closed episodes, rollups, dwell) comes from [`/api/history`](#history-rest-api-apihistory), not this socket.

**Durable record.** Accepted batches are persisted by `server/app/recorder.py` to SQLite (`PARKING_DB_PATH`, default `occupancy.db`) as per-bay occupancy episodes — bay id, state, `since`/`until` (server clock, ISO 8601 UTC), source frame ids, confidence, and the session's `bayMapVersion`. Reporting is idempotent (a duplicate open is a no-op; empty→empty is a no-op) and open episodes survive a restart untouched — the restart-persistence test is the acceptance gate (`server/tests/test_recorder.py`, `test_ws_detect.py::TestBayStateRecording`).

**Backend → Frontend** — JSON text message per frame processed:

```json
{
  "type": "detections",
  "frameId": 412,
  "latencyMs": 23.4,
  "inferenceMs": 18.1,
  "detections": [
    { "cls": "truck", "conf": 0.91, "bbox": [0.12, 0.30, 0.18, 0.11] }
  ]
}
```

`bbox` is `[x, y, w, h]` normalized to `0..1`, origin at the **top-left** of the frame (matching canvas coordinates).

Malformed input (undecodable JPEG, missing frame header, invalid JSON) is answered with `{ "type": "error", "message": "…" }` and the socket stays open.

**Confirmed transitions (debounce + hysteresis).** Per-frame occupancy can flicker on noisy detections, so the frontend only reports a transition once the new state has held for a time-based debounce — in *seconds*, not frames, because capture rate varies (`src/bays/stabilizer.ts`). Hysteresis makes the holds directional: entering `occupied` requires the truck to be seen for `ENTER_OCCUPIED_SECS` (2s); leaving it requires absence to hold `LEAVE_OCCUPIED_SECS` (4s), so near-miss maneuvers and momentary detection dropouts never flip a state. Bays start implicitly empty — "still empty" is never reported — and a batch dropped while the socket is down is not re-sent after reconnect (the stabilizer keeps its confirmed state, so no duplicates). The same confirmed states (each stamped with a `sinceMs` set only on confirmed transitions) feed the store snapshot and the board, so the UI cannot flicker independently of the record.

**Backpressure (latest-wins).** Inference runs off the event loop, and at most one frame is queued at a time: when a newer complete frame arrives, the queued one is dropped and never replied to. Clients match replies by `frameId` and drop stale results, so under load (inference slower than capture) the backlog converges to the newest frame instead of growing without bound. When the client keeps pace, every frame gets a reply.

By default the server runs a **stub detector** (`PARKING_DETECTOR=stub`) that returns canned, deterministic trucks: one parked and one sweeping across the frame per `frameId` — useful for frontend work without model weights. Set `PARKING_DETECTOR=yolo` (plus `pip install -e ".[model]"`) to run real YOLOv8n inference: the model lazy-loads exactly once (weight load failures surface as a 503 on `/health`), detections are filtered to the configured COCO classes (`PARKING_ALLOWED_CLASSES`, default `truck`), and `PARKING_CONF_THRESHOLD` tunes confidence.

### History REST API (`/api/history`)

Read-only GET endpoints over the durable record — any client (a shift supervisor's browser, a webhook consumer, `curl`), not just the live socket, can review the yard's history. JSON contracts live in `server/app/schemas.py` (pydantic, camelCase); aggregation math in `server/app/history.py` (pure, unit-tested); the router in `server/app/api_history.py`. All timestamps are ISO 8601 UTC (timezone-aware `from`/`to` required; naive values are rejected as ambiguous); durations are seconds. A trailing-24h window is used when both bounds are omitted. `bayId`/`from`/`to` echo back in every response. The store only ever holds occupancy episodes — no pixels are stored anywhere in this surface.

- `GET /api/history/timeline/{bayId}?from=&to=` — one bay's occupancy episodes over the window (the "what happened, when" view). Each entry carries `since`/`until` (`until` null while open), `open`, `durationSeconds`, `confidence`, source frame ids, and the `mapVersion` the episode was observed under.

  ```json
  { "bayId": 0, "from": "…", "to": "…", "intervals": [
    { "id": 7, "bayId": 0, "mapVersion": "feedface", "since": "…", "until": "…",
      "open": false, "durationSeconds": 9052.1, "confidence": 0.91,
      "openFrameId": 412, "closeFrameId": 512 }
  ] }
  ```

- `GET /api/history/dwell?from=&to=&bayId=` — per-bay dwell summaries: `episodes`, `totalSeconds`/`meanSeconds`/`maxSeconds` (clipped to the window), and the episode still open at query time, if any (`open`, accrues to the window end).

- `GET /api/history/rollups?granularity=day|shift&from=&to=&bayId=` — occupied seconds per bay per bucket. `day` buckets are UTC calendar days; `shift` buckets are `shiftHours` long (default 12) aligned to `shiftStartHour` UTC (default 6). Episodes spanning a boundary are pro-rated across buckets (a truck parked over a shift boundary contributes time to both shifts); only bays with positive occupied time appear per bucket.

Validation failures (`bad from`/`to`, unknown granularity, out-of-range shift parameters) answer `422`; a degraded record store answers `503` (mirroring the WebSocket path — see `/health`). Queries are read-only and safe to run against the live service while frames are being recorded.

**History view (frontend, bead rzo.4).** The header's **History** toggle swaps the live yard for the occupancy history board (`src/ui/HistoryPanel.tsx`, fetch glue in `App.tsx`): a horizontal per-bay timeline for a chosen shift — recorded episodes drawn as proportional segments across the window, open episodes extending to the window edge — plus a per-bay dwell column (episode count · total occupied time · "open now"). The zero-effort shift picker offers **Current shift** (default) and **Last night**; shift boundaries mirror the server's rollup defaults (06:00/18:00 UTC — `src/history/shifts.ts` must stay in sync with `api_history.py`). Data loads on demand per view/shift (`src/net/history-api.ts`, `src/history/load.ts`); failures render a "History unavailable" banner, not a broken board. Segment geometry is percentage-of-window UI math — the normalized-coordinate invariant is untouched. Point the client elsewhere with `VITE_HISTORY_API_URL` (default: same origin, like the alerts client).

### Alerts (`/api/alerts`, bead rzo.5)

A small rules engine derives alerts from the same durable record — no second source of truth, no pixels, and the rules never re-derive occupancy (invariant 5: they read what the frontend reported). Two rules cover the roadmap's conditions:

- **`overstay`** — a bay occupied past its dwell window. This is the "blocked bay / truck that never leaves" condition: the bay is unavailable past its expected turnover time. The per-bay dwell window is **data, not code**: `dwellMinutes` (default 240) with `dwellMinutesByBay` overrides keyed by stable bay id, living in `server/alert_rules.json` (path overridable via `PARKING_ALERT_RULES`).
- **`afterHours`** — an episode that *opened* outside the configured active hours (`activeHours: {startHour, endHour}` UTC, default 06:00–22:00; midnight-wrapping windows supported) — overnight/after-hours activity. Closed episodes still count: a truck that stayed overnight and left at dawn still deserves the alert.

**Evaluation is a sweep, not a timer.** Every `bayState` batch (and every `GET /api/alerts` listing) re-derives which alerts the record implies *now*: open episodes accrue toward their dwell window, and an episode opened outside active hours flags even after it closes. A truck that sits 5 hours silently therefore still gets its overstay alert the moment any event arrives or someone looks at the panel — no background tasks, no protocol changes.

**Dedup + persistence.** Alerts live in the same SQLite record as occupancy history (`alerts` table, unique per `(rule, episode)`), so the sweep is idempotent — an alert is raised exactly once per rule per episode, and alerts survive a restart together with the record (`tests/test_alert_store.py` restart test is the acceptance gate).

**Delivery.** In-app first: the sidebar notification area (`src/ui/AlertsPanel.tsx`) polls `GET /api/alerts?unacknowledged=true` every 15s (`src/sim/alert-polling.ts`), shows bay + rule + coarse age + detail copy, and acknowledges via `POST /api/alerts/{id}/ack` (optimistic UI; the next poll restores the authoritative list). Plus a pluggable webhook out: set `PARKING_ALERT_WEBHOOK_URL` and every newly raised alert is POSTed as JSON (best-effort, off the event loop, 10s timeout — a failing webhook is logged and never blocks recording; the alert remains in the durable record). Email/SMS are deferred — they would be further `AlertSink` implementations (`server/app/webhook.py`), not new alert logic.

```json
{ "alerts": [{ "id": 7, "bayId": 1, "rule": "overstay", "since": "…", "raisedAt": "…",
  "acknowledged": false, "detail": { "dwellMinutes": 240, "elapsedMinutes": 305.2, "stillOpen": true } }] }
```

A degraded alert surface (store open failure, malformed rules file) degrades exactly like the recorder: surfaced via `alerts` on `/health`, the API answers `503`, and the live board keeps working.

### Parking bay occupancy

- Bays are defined in `bays.json` as normalized rectangles (same coordinate space as detections), so bay layout can be tuned without code changes. The current map holds **four bays in a single far-side (north) rank** facing the warehouse dock; the near rank between camera and lane was removed in the depot-yard overhaul because its overlay boxes stacked on the far ones.
- **Bay rects are derived from the scene, not eyeballed.** Each rect is the AABB of the bay quad's corners projected through the approved default camera (same NDC → normalized top-left math as `frontend/src/scene/gt.ts`). Moving the camera or the bay layout invalidates `bays.json` — regenerate it with the projection, or occupancy scoring silently drifts (stale rects don't error).
- **Bays are identities, not model output.** A bay's identity is its stable `id` in the bay map; the detector only sees trucks and knows nothing about bays. Occupancy is derived entirely in the frontend by matching truck bboxes against the bay map (`frontend/src/bays/occupancy.ts`). A real-world deployment would replace the hand-authored bay map with a CV calibration pass that persists detected bay rects — the runtime matching layer would not change.
- A bay is **FULL** when `IoU(truck bbox, bay rect) ≥ threshold` (default `0.3`, see [Threshold tuning measurements](#threshold-tuning-measurements)), or when the truck's bbox center falls inside the bay (configurable strategy).
- The frontend draws bay outlines colored by state (green = empty, red = full), and the sidebar lists one card per bay with its live state (`Clear · N% confidence` / `Occupied · truck detected`).

### Frontend UI (React shell)

The UI is a React 18 app mounted over the imperative sim pipeline (`frontend/src/main.tsx` → `App.tsx`):

- **State**: a single immutable-snapshot store (`src/state/store.ts`) created at the composition root; React reads it through `useSyncExternalStore` (`src/state/react.ts`). The render loop reads the latest snapshot per frame — no subscriptions, no awaits (decoupled render/inference).
- **Header** (`src/ui/AppHeader.tsx`): connection pill (green "Live feed connected" / red "Live feed offline"), inference health pill (`InferenceStatus.tsx`: healthy / degraded / offline from connection status + `latencyMs`, `INFERENCE_HEALTHY_MAX_MS` in `src/config.ts`, with live fps/latency stats) — the two status pills form one cluster in the header meta row — plus the camera chip, the History/Live view toggle (rzo.4), and the Start/Stop control. Restacks on mobile (<768px). No brand/logo: the header starts with the status cluster (branding removed).
- **Sidebar** (`src/ui/`): one card per bay from `bays.json` (identity = bay id, occupancy from frontend matching), color-coded by state (green clear / red occupied / gray no-data), plus the alerts notification area above it (`AlertsPanel.tsx`, renders only when there is news).
- **History board** (`src/ui/HistoryPanel.tsx`, rzo.4): replaces the main region while open — per-bay horizontal occupancy timeline for the chosen shift + dwell column, fed on demand from `/api/history` (see the History REST API section above).
- **The React UI is the HUD.** The 2D overlay canvas (`src/overlay/overlay.ts`) draws only detection boxes + bay rects; the former canvas HUD (fps/latency text, offline banner) was replaced by the header status pills.
- **Offline/reconnect**: the WebSocket client reconnects with backoff (`src/net/backoff.ts`); while disconnected the sim keeps rendering, the overlay freezes on the last accepted result, and the pill + health card show the offline state until the socket re-opens.
- **`?gt` dev mode** bypasses the pipeline entirely (no overlay/WS): the sim renders as usual while a secondary loop exports ground-truth JPEG+box pairs (see [Fine-tuning](#fine-tuning-for-the-sim-domain-why-the-weights-are-custom)).

### Performance & tuning

All knobs are environment variables (see `server/app/config.py`):

| Variable | Default | Effect |
| --- | --- | --- |
| `PARKING_DETECTOR` | `stub` | `stub` (canned boxes) or `yolo` (real model) |
| `PARKING_MODEL_NAME` | `yolov8n.pt` | Any Ultralytics weights (local `.pt` path for fine-tuned models) |
| `PARKING_CONF_THRESHOLD` | `0.35` | Minimum detection confidence |
| `PARKING_ALLOWED_CLASSES` | `truck` | Comma-separated COCO class names |
| `PARKING_IMGSZ` | *(model default, 640)* | Inference input size (longest edge, px). Larger = better small-object recall, proportionally slower |
| `PARKING_TORCH_THREADS` | *(torch default)* | Cap on torch intra-op threads. Set to the machine's vCPU count — **must be 1 on single-vCPU hosts** (Fly shared/performance-1x), where torch's per-host-core default thrashes the quota |
| `PARKING_HOST` / `PARKING_PORT` | `127.0.0.1` / `8000` | Bind address |
| `PARKING_DB_PATH` | `occupancy.db` | SQLite file for the durable record (occupancy episodes + alerts) |
| `PARKING_ALERT_RULES` | `alert_rules.json` | Alert thresholds as data (per-bay dwell windows, active hours); missing file = built-in defaults |
| `PARKING_ALERT_WEBHOOK_URL` | *(unset)* | Webhook URL for alert delivery out of the app; unset = in-app only |
| `VITE_HISTORY_API_URL` | *(unset)* | Build-time override for the history REST base (`/api/history`); unset = same origin |

Measured inference latency (yolov8n, CPU, Apple Silicon, Ultralytics `bus.jpg`, `conf=0.35`):

| `PARKING_IMGSZ` | Median inference | Boxes found |
| --- | --- | --- |
| 320 | ~12 ms | 4 |
| 640 (default) | ~34 ms | 4 |
| 960 | ~80 ms | 5 |
| 1280 | ~128 ms | 7 |

#### Threshold tuning measurements

Measured (2026-09-05) against the ground-truth dataset used for fine-tuning
(503 frames / 2 293 projected truck boxes), running `simtruck.pt` offline and
replaying the frontend occupancy rule per frame. Ground truth: a bay is
occupied while a truck is parked in it (≥ ~3 s of continuous coverage);
shorter trigger runs are drive-throughs.

**Confidence threshold — keep 0.35.** `simtruck.pt` true positives: 2 264 at
conf 0.43–0.98 (median 0.96); noise detections: 9, all conf ≤ 0.67 and all
far from bays — **zero** occupancy-relevant false positives at 0.35. Raising
the threshold only trades real trucks for noise: at 0.5, 3 true positives
(each one a false-empty bay) are lost to remove 8 detections that never
triggered a bay anyway. Any threshold in [0.35, 0.5] is occupancy-equivalent
here; 0.35 keeps the largest margin under the true-positive band.

**Bay IoU threshold — 0.2 → 0.3.** Replaying the occupancy rule
(IoU ≥ thr OR truck center in margin-grown bay rect) per frame:

| Rule | Parked-truck frames (TP) | Drive-through trigger frames (FP) |
| --- | --- | --- |
| IoU ≥ 0.2 + center | 1 154 | 111 |
| IoU ≥ 0.3 + center | 1 085 | **28** |
| IoU ≥ 0.3, no center | 1 034 | 4 |

The center fallback (kept — it covers parked trucks whose bbox outgrows the
bay rect) is the source of most drive-through false positives; raising the
IoU threshold removes the IoU-only ones (−75%) at a ~6% TP cost that is
concentrated in the 2.2 s parking/leaving tween (the truck is still
maneuvering). With the fallback retained, no parked truck is ever missed.

**Health-card impact: none.** Both knobs are post-inference filters (server-side
class/conf filter, frontend IoU math), so `inferenceMs` / `latencyMs` /
`captureFps` are unaffected — live baseline remains 70–90 ms `infer`
(imgsz 960, CPU) at ~11 fps capture. Backpressure behavior under load is
covered by `test_backlog_coalesces_to_latest_frame` (superseded frames are
skipped server-side, the newest always wins, and the socket stays usable
after a burst).

Rule of thumb: latency scales ~quadratically with `imgsz`. Raise it only when small objects are being missed; at the default 10–15 fps capture, even 960 keeps end-to-end latency under a second. Benchmark via the health card's latency figure (`latencyMs`) before and after any tuning change.

#### Fine-tuning for the sim domain (why the weights are custom)

Stock COCO `yolov8n.pt` detects **zero** trucks on this sim's frames — measured, not
assumed: across real captures × upscale factors × `imgsz` {640–1280}, no truck/car/bus
appears (only noise classes); yolov8s likewise; yolov8m only sporadically at conf
0.11–0.32 and 220–360 ms/frame. COCO trucks are textured photos; the sim's are
flat-shaded low-poly boxes — a domain gap no amount of threshold tuning closes.

The fix: fine-tune on frames from the sim itself, with **ground truth projected
straight out of the three.js scene graph** (no human labeling — the simulator knows
exactly where every truck is):

```bash
# 1. Collect: run the collector, open http://localhost:5173/?gt=1 for a few minutes
cd server && source .venv/bin/activate
python scripts/gt_collect.py /tmp/simtruck-gt/raw.jsonl
# 2. Convert JSONL → Ultralytics dataset (class 0 = truck)
python scripts/make_yolo_dataset.py /tmp/simtruck-gt/raw.jsonl /tmp/simtruck-gt/dataset
# 3. Train (~30 min on Apple MPS)
python scripts/train_simtruck.py /tmp/simtruck-gt/dataset/simtruck.yaml <run_dir>
# 4. Deploy (weights are gitignored *.pt — keep them local)
PARKING_DETECTOR=yolo PARKING_MODEL_NAME=simtruck.pt uvicorn app.main:app --port 8000
```

Measured on the 2026-09-05 run (511 frames / 2 293 auto-labeled boxes, 453/50 train/val):
val precision ≈ 0.99, recall ≈ 0.99, mAP50 ≈ 0.995 by epoch 4; live e2e in the sim:
3–5 trucks per frame at conf 0.95–0.98, health-card latency 70–90 ms (imgsz 960, CPU) at
11 fps capture, bay states flipping FULL/EMPTY as trucks park. Class names are
resolved from the loaded model's own `names` mapping, so stock COCO models
(truck = 7) and fine-tuned single-class models (truck = 0) need no config change.

Trade-off to be aware of: the fine-tuned model is a **sim specialist** — near-perfect
in this domain, weaker than stock COCO weights on real-world photos. That is the
correct trade for a demo whose camera is this sim; if the scene ever changes
(assets, camera, palette), regenerate the dataset the same way and retrain (~30 min).
(The 2026-09-05 depot-yard overhaul proved this rule twice: the first retrain
ran on frames captured after the new 4-bay layout and rigid truck landed but
**before** the warehouse/treeline scenery did — the resulting weights fired on
trees and missed trucks parked at the dock. Recollecting from the finished
scene (940 frames / 2 265 boxes, ~6 min of `?gt` capture) and retraining
(early-stopped at epoch 27/50: precision 1.00, recall 0.996, mAP50 0.995,
mAP50-95 0.989) cleared both failure modes — parked-at-dock detection and the
treeline false positives.)

## Project layout

```
parking-bay-detection/
├── frontend/               # Vite + TypeScript + Three.js simulation
│   ├── src/
│   │   ├── main.tsx        # React entry (mounts <App/> into #root)
│   │   ├── App.tsx         # app shell: header, viewport, sidebar
│   │   ├── ui/             # React components (AppHeader, bay cards, health card, primitives, tokens)
│   │   ├── state/          # immutable app-state store + React adapter (useSyncExternalStore)
│   │   ├── sim/            # mountSim bootstrap: capture → detect → overlay glue; alert polling
│   │   ├── scene/          # three.js depot yard: world/camera/sky, bay paint, scenery, rigid truck model + actors, ?gt capture
│   │   ├── capture/        # canvas → JPEG frame capture + throttling
│   │   ├── net/            # WebSocket client (reconnect/backoff), frame ID bookkeeping; alerts + history REST clients
│   │   ├── overlay/        # 2D canvas overlay (detection boxes + bay rects only)
│   │   ├── history/        # history view model: shift windows, timeline geometry/copy, /api/history loader
│   │   └── bays/           # bay config loading + occupancy (IoU) logic
│   ├── public/bays.json    # parking bay definitions (normalized rects)
│   └── index.html
├── server/                 # FastAPI + YOLO inference service
│   ├── app/
│   │   ├── main.py         # FastAPI app, /health, /ws/detect, /api/history + /api/alerts routers
│   │   ├── detection.py    # YOLO model wrapper (lazy-load, class filter)
│   │   ├── recorder.py     # durable SQLite occupancy record (bay episodes)
│   │   ├── history.py      # pure history aggregation (timeline, dwell, rollups)
│   │   ├── api_history.py  # read-only REST router: /api/history/*
│   │   ├── alerts.py       # alert rules engine (pure sweep; thresholds as data)
│   │   ├── alert_store.py  # durable SQLite alert record (dedup per rule+episode)
│   │   ├── api_alerts.py   # alert REST router: /api/alerts, /api/alerts/{id}/ack
│   │   ├── webhook.py      # pluggable alert delivery (HTTP webhook out)
│   │   ├── schemas.py      # pydantic JSON contracts for the REST surfaces
│   │   └── config.py       # model name, conf threshold, classes, db path, port
│   ├── alert_rules.json    # alert thresholds as data (per-bay dwell windows, active hours)
│   ├── tests/
│   └── pyproject.toml
├── README.md
└── AGENTS.md
```

## Getting started

### Prerequisites

- Node.js ≥ 20
- Python ≥ 3.11
- (First run) the YOLO model weights download automatically (~6 MB for `yolov8n.pt`)

### Backend

```bash
cd server
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"          # or: pip install fastapi uvicorn ultralytics
uvicorn app.main:app --reload --port 8000
```

Health check: `curl localhost:8000/health` → `{"status": "ok", "model": "yolov8n"}`

### Frontend

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173
```

The frontend connects to `ws://localhost:8000/ws/detect` by default (override with `VITE_DETECT_WS_URL`). When no override is set it derives the URL from the page origin (`wss://<host>/ws/detect` on https), which is what makes single-origin deployments work with zero configuration.

## Deployment (single Fly.io container)

The whole app deploys as one Fly.io machine: a multi-stage `Dockerfile` builds `frontend/dist` (node stage) and serves it from FastAPI at `/` (python stage), so the browser loads the sim and opens `wss://<app>.fly.dev/ws/detect` on the **same origin** — no CORS, no separate frontend hosting, no per-env `VITE_DETECT_WS_URL` build.

```bash
fly launch --no-deploy   # reads fly.toml; pick a unique app name if taken
fly deploy
fly status               # then open https://<app>.fly.dev
```

- The image bakes in `server/simtruck.pt` and sets `PARKING_DETECTOR=yolo`, `PARKING_MODEL_NAME=/srv/models/simtruck.pt` (weights are in the image, so `/health` never depends on network at boot).
- Sized `performance-1x` / 2048 MB (~$13–16/mo): **dedicated** vCPU. Inference measured ~80 ms on a multithreaded laptop CPU (imgsz 960) but 2–5 s on `shared-cpu-1x` under burst throttling — the shared quota, not the wire protocol, was the latency source. `PARKING_TORCH_THREADS=1` is set in `fly.toml` (1 vCPU ⇒ 1 thread). For a stub-detector demo, set `PARKING_DETECTOR=stub` and drop to `shared-cpu-1x` / 256 MB (~$2/mo).
- The client paces capture to server replies (≤ 1 frame in flight), so a slow backend bounds latency to ~1 inference instead of accumulating frames; the 12 fps throttle still caps the fast path.
- `auto_stop_machines = "suspend"` bills nothing while idle; an incoming request wakes it (suspend/resume keeps RAM, so the loaded model survives). Active WebSocket sessions keep the machine running.
- Serving the frontend from FastAPI is controlled by `PARKING_STATIC_DIR` (set to `/srv/static` in the image). If the directory is absent — local dev, tests — nothing is mounted and the frontend runs from the Vite dev server as usual.

## Known considerations

- **COCO `truck` class** (class 7) covers medium/heavy trucks; pickup-style trucks may partially match `car`. If detection quality is poor on the synthetic scene, fine-tune on frames auto-labeled from the simulation's own ground truth — the sim knows exactly where every truck is.
- **Latency budget.** At 10–15 fps capture and ~20–50 ms inference on CPU (yolov8n), the overlay trails the sim by well under a second. Interpolating box positions between detections is a possible polish item.
- **Capture resolution vs display.** Capture at a fixed modest resolution (960×540) regardless of window size; the frontend maps normalized boxes back to display pixels.