"""Fine-tune YOLOv8n on sim-truck ground-truth frames (bead 0ak.2 / cfr.2).

WHY (run-log context, 2026-09-05):
    Stock COCO yolov8n detects ZERO trucks on frames captured from the
    three.js sim. Verified offline before training: 3 real sim frames x
    {native, 2x Lanczos upscale} x imgsz {640, 1280} -> zero truck/car/bus
    detections (only noise: chair, airplane, clock). yolov8s: none. yolov8m:
    sporadic truck conf 0.11-0.32 (below the 0.35 threshold) at 220-360
    ms/frame. Conclusion: domain gap - COCO trucks are textured photos, our
    trucks are flat-shaded low-poly boxes. The fix chosen was to fine-tune
    on synthetic frames from the sim itself rather than make the sim look
    like COCO photos.

HOW the dataset was made (no human labeling):
    1. `gt_collect.py` serves as the receiver (POST :9999/frame -> JSONL).
    2. Frontend `?gt=1` debug mode (frontend/src/scene/gt.ts) renders the
       sim, captures 960x540 JPEGs at ~2 fps, and projects EXACT truck
       bounding boxes out of the three.js scene graph (Box3 over each truck
       group, corners through camera.project -> normalized top-left origin).
       Each frame + boxes pair is POSTed as JSON {id, jpeg(base64), width,
       height, boxes}. ~4 minutes of wall clock gave 511 frames / 2293 boxes,
       0-6 trucks per frame, spanning approach/parking/parked phases.
    3. `make_yolo_dataset.py` converts JSONL -> Ultralytics layout
       (images/labels, train/val 90/10, class 0 = truck, boxes < 6 px
       dropped as unlearnable). YOLO labels share our normalized top-left
       convention, so conversion is corner -> center form only, no flip.

TRAINING (this script): yolov8n, imgsz 960 (= native capture resolution,
no downscaling of small trucks), 50 epochs, batch 8, Apple MPS GPU,
~35 s/epoch (~30 min total). Val metrics from epoch 2 onward:
precision ~0.99, recall ~0.99, mAP50 ~0.995 (run 2026-09-05:
/tmp/simtruck-gt/runs/simtruck). Result: fine-tuned model finds 5-7 trucks
at conf up to 0.99 on held-out sim frames where stock yolov8n found zero.

DEPLOYMENT:
    Copy the best weights into the repo (they are gitignored *.pt, so place
    them locally, e.g. server/simtruck.pt) and run the server with:
        PARKING_DETECTOR=yolo PARKING_MODEL_NAME=simtruck.pt
    Class names are resolved from the model's own `names` mapping
    (app/detection.py), so the fine-tuned model's truck=0 works alongside
    stock COCO models (truck=7) with no config change.

Usage: python scripts/train_simtruck.py [dataset_yaml] [run_dir]
"""

from __future__ import annotations

import sys

from ultralytics import YOLO


def main() -> None:
    data = sys.argv[1] if len(sys.argv) > 1 else "/tmp/simtruck-gt/dataset/simtruck.yaml"
    project = sys.argv[2] if len(sys.argv) > 2 else "/tmp/simtruck-gt/runs"
    model = YOLO("yolov8n.pt")  # start from COCO pretrain; transfer learning
    model.train(
        data=data,
        epochs=50,  # metrics plateau by ~epoch 4-5; extra epochs are polish
        imgsz=960,  # match capture resolution (960x540); preserves small trucks
        batch=8,
        device="mps",  # Apple Silicon GPU; use "cpu" if unavailable
        project=project,
        name="simtruck",
        exist_ok=True,
        patience=50,  # early stopping effectively off; metrics plateau early
    )


if __name__ == "__main__":
    main()
