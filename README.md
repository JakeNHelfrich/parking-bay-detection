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
- A bay is **FULL** when `IoU(truck bbox, bay rect) ≥ threshold` (default `0.2`), or when the truck's bbox center falls inside the bay (configurable strategy).
- The frontend draws bay outlines colored by state (green = empty, red = full) and a summary count.

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

Rule of thumb: latency scales ~quadratically with `imgsz`. Raise it only when small objects are being missed; at the default 10–15 fps capture, even 960 keeps end-to-end latency under a second. Benchmark via the HUD's `inferenceMs` before and after any tuning change.

## Project layout

```
parking-bay-detection/
├── frontend/               # Vite + TypeScript + Three.js simulation
│   ├── src/
│   │   ├── main.ts         # bootstrap, render loop
│   │   ├── scene/          # three.js scene, trucks, bays, camera
│   │   ├── capture/        # canvas → JPEG frame capture + throttling
│   │   ├── net/            # WebSocket client, frame ID bookkeeping
│   │   ├── overlay/        # 2D canvas overlay (boxes, bay states, HUD)
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

The frontend connects to `ws://localhost:8000/ws/detect` by default (override with `VITE_DETECT_WS_URL`).

## Milestones

| Phase | Deliverable |
|-------|-------------|
| **M1 — Simulation** | Three.js scene: ground plane, parking bays, trucks that drive in, park, and leave. Orbit camera. |
| **M2 — Server skeleton** | FastAPI app with `/health` and `/ws/detect`. YOLO stubbed out (returns canned boxes) so the frontend can be built before the model lands. |
| **M3 — Frame pipeline** | ✅ Canvas capture + throttling, WS client, overlay rendering of returned boxes, latency HUD. End-to-end with the stub. |
| **M4 — Real detection** | ✅ YOLOv8n backend with lazy single load, COCO class filter, env-tunable confidence threshold, real latency in the HUD. Verified end-to-end over the WS. |
| **M5 — Bay occupancy** | ✅ `bays.json` loading, IoU matching, FULL/EMPTY coloring and counts. |
| **M6 — Tuning & polish** | Threshold tuning, stale-frame handling under load, optional synthetic-data fine-tuning loop (sim ground truth → auto-label → fine-tune YOLO). |

## Known considerations

- **COCO `truck` class** (class 7) covers medium/heavy trucks; pickup-style trucks may partially match `car`. If detection quality is poor on the synthetic scene, fine-tune on frames auto-labeled from the simulation's own ground truth — the sim knows exactly where every truck is.
- **Latency budget.** At 10–15 fps capture and ~20–50 ms inference on CPU (yolov8n), the overlay trails the sim by well under a second. Interpolating box positions between detections is a possible polish item.
- **Capture resolution vs display.** Capture at a fixed modest resolution (960×540) regardless of window size; the frontend maps normalized boxes back to display pixels.