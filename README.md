# Parking Bay Detection

A computer-vision project that detects trucks and parking-bay occupancy in a **simulated** 3D scene.

A TypeScript + Three.js frontend renders a simulated parking lot with moving trucks. Frames of the simulation are streamed to a Python FastAPI backend running a YOLO object-detection model. The backend returns bounding boxes for detected trucks, which are overlaid back onto the frontend in real time. Parking bays are then marked **FULL** or **EMPTY** based on whether a detected truck overlaps them.

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

A session header sent once to negotiate capture size:

```json
{ "type": "hello", "captureWidth": 960, "captureHeight": 540 }
```

A per-frame text header sent immediately before each binary JPEG, so the server can echo the frame ID:

```json
{ "type": "frame", "frameId": 412 }
```

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

**Backpressure (latest-wins).** Inference runs off the event loop, and at most one frame is queued at a time: when a newer complete frame arrives, the queued one is dropped and never replied to. Clients match replies by `frameId` and drop stale results, so under load (inference slower than capture) the backlog converges to the newest frame instead of growing without bound. When the client keeps pace, every frame gets a reply.

By default the server runs a **stub detector** (`PARKING_DETECTOR=stub`) that returns canned, deterministic trucks: one parked and one sweeping across the frame per `frameId` — useful for frontend work without model weights. Set `PARKING_DETECTOR=yolo` (plus `pip install -e ".[model]"`) to run real YOLOv8n inference: the model lazy-loads exactly once (weight load failures surface as a 503 on `/health`), detections are filtered to the configured COCO classes (`PARKING_ALLOWED_CLASSES`, default `truck`), and `PARKING_CONF_THRESHOLD` tunes confidence.

### Parking bay occupancy

- Bays are defined in `bays.json` as normalized rectangles (same coordinate space as detections), so bay layout can be tuned without code changes.
- **Bays are identities, not model output.** A bay's identity is its stable `id` in the bay map; the detector only sees trucks and knows nothing about bays. Occupancy is derived entirely in the frontend by matching truck bboxes against the bay map (`frontend/src/bays/occupancy.ts`). A real-world deployment would replace the hand-authored bay map with a CV calibration pass that persists detected bay rects — the runtime matching layer would not change.
- A bay is **FULL** when `IoU(truck bbox, bay rect) ≥ threshold` (default `0.3`, see [Threshold tuning measurements](#threshold-tuning-measurements)), or when the truck's bbox center falls inside the bay (configurable strategy).
- The frontend draws bay outlines colored by state (green = empty, red = full), and the sidebar lists one card per bay with its live state (`Clear · N% confidence` / `Occupied · truck detected`).

### Frontend UI (React shell)

The UI is a React 18 app mounted over the imperative sim pipeline (`frontend/src/main.tsx` → `App.tsx`):

- **State**: a single immutable-snapshot store (`src/state/store.ts`) created at the composition root; React reads it through `useSyncExternalStore` (`src/state/react.ts`). The render loop reads the latest snapshot per frame — no subscriptions, no awaits (decoupled render/inference).
- **Header** (`src/ui/AppHeader.tsx`): BAYWATCH brand, connection pill (green "Live feed connected" / red "Live feed offline"), camera chip, Start/Stop control. Restacks to three rows on mobile (<768px).
- **Sidebar** (`src/ui/`): one card per bay from `bays.json` (identity = bay id, occupancy from frontend matching) plus an **inference health card** (`InferenceHealthCard.tsx`): healthy / degraded / offline from connection status + `latencyMs` (`INFERENCE_HEALTHY_MAX_MS` in `src/config.ts`).
- **The React UI is the HUD.** The 2D overlay canvas (`src/overlay/overlay.ts`) draws only detection boxes + bay rects; the former canvas HUD (fps/latency text, offline banner) was replaced by the header pill and health card.
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
| `PARKING_HOST` / `PARKING_PORT` | `127.0.0.1` / `8000` | Bind address |

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

## Project layout

```
parking-bay-detection/
├── frontend/               # Vite + TypeScript + Three.js simulation
│   ├── src/
│   │   ├── main.tsx        # React entry (mounts <App/> into #root)
│   │   ├── App.tsx         # app shell: header, viewport, sidebar
│   │   ├── ui/             # React components (AppHeader, bay cards, health card, primitives, tokens)
│   │   ├── state/          # immutable app-state store + React adapter (useSyncExternalStore)
│   │   ├── sim/            # mountSim bootstrap: capture → detect → overlay glue
│   │   ├── scene/          # three.js scene, trucks, bays, camera, ?gt capture
│   │   ├── capture/        # canvas → JPEG frame capture + throttling
│   │   ├── net/            # WebSocket client (reconnect/backoff), frame ID bookkeeping
│   │   ├── overlay/        # 2D canvas overlay (detection boxes + bay rects only)
│   │   └── bays/           # bay config loading + occupancy (IoU) logic
│   ├── public/bays.json    # parking bay definitions (normalized rects)
│   └── index.html
├── server/                 # FastAPI + YOLO inference service
│   ├── app/
│   │   ├── main.py         # FastAPI app, /health, /ws/detect
│   │   ├── detection.py    # YOLO model wrapper (lazy-load, class filter)
│   │   └── config.py       # model name, conf threshold, classes, port
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
- Sized `shared-cpu-1x` / 1024 MB (~$4–8/mo): CPU torch + the fine-tuned model want ~700 MB resident. For a stub-detector demo, set `PARKING_DETECTOR=stub` and drop memory to 256 MB in `fly.toml` (~$2/mo).
- `auto_stop_machines = "suspend"` bills nothing while idle; an incoming request wakes it. Active WebSocket sessions keep the machine running.
- Serving the frontend from FastAPI is controlled by `PARKING_STATIC_DIR` (set to `/srv/static` in the image). If the directory is absent — local dev, tests — nothing is mounted and the frontend runs from the Vite dev server as usual.

## Milestones

| Phase | Deliverable |
|-------|-------------|
| **M1 — Simulation** | Three.js scene: ground plane, parking bays, trucks that drive in, park, and leave. Orbit camera. |
| **M2 — Server skeleton** | FastAPI app with `/health` and `/ws/detect`. YOLO stubbed out (returns canned boxes) so the frontend can be built before the model lands. |
| **M3 — Frame pipeline** | ✅ Canvas capture + throttling, WS client, overlay rendering of returned boxes, latency surfaced in the UI. End-to-end with the stub. |
| **M4 — Real detection** | ✅ YOLOv8n backend with lazy single load, COCO class filter, env-tunable confidence threshold, real latency in the health card. Verified end-to-end over the WS. |
| **M5 — Bay occupancy** | ✅ `bays.json` loading, IoU matching, FULL/EMPTY coloring and counts. |
| **M6 — Tuning & polish** | ✅ Threshold/inference tuning knobs, latest-wins backpressure, synthetic-data fine-tuning (auto-labeled sim ground truth → fine-tuned yolov8n; sim trucks detected at 0.95+ live). |

## Known considerations

- **COCO `truck` class** (class 7) covers medium/heavy trucks; pickup-style trucks may partially match `car`. If detection quality is poor on the synthetic scene, fine-tune on frames auto-labeled from the simulation's own ground truth — the sim knows exactly where every truck is.
- **Latency budget.** At 10–15 fps capture and ~20–50 ms inference on CPU (yolov8n), the overlay trails the sim by well under a second. Interpolating box positions between detections is a possible polish item.
- **Capture resolution vs display.** Capture at a fixed modest resolution (960×540) regardless of window size; the frontend maps normalized boxes back to display pixels.