"""Convert gt_collect.py JSONL output into a YOLO detection dataset.

Input: JSONL records {id, jpeg (base64), width, height, boxes:[{x,y,w,h}]}
(normalized top-left origin). Output: standard Ultralytics layout:

    <out>/images/train/*.jpg   <out>/labels/train/*.txt
    <out>/images/val/*.jpg     <out>/labels/val/*.txt
    <out>/simtruck.yaml

YOLO label format is `class cx cy w h` — normalized, top-left origin, i.e.
the SAME convention as our boxes, just converted from corner to center form
(no y-flip; capture and YOLO labels share a top-left origin).

Boxes smaller than MIN_BOX_PX in either dimension at capture resolution are
dropped (distant trucks a few pixels wide are noise, not learnable signal).

Usage: python scripts/make_yolo_dataset.py <raw.jsonl> <out-dir>
"""

from __future__ import annotations

import base64
import io
import json
import random
import sys
from pathlib import Path

MIN_BOX_PX = 6.0
VAL_FRACTION = 0.1
SEED = 42


def main() -> None:
    raw_path, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    records = [json.loads(line) for line in raw_path.read_text().splitlines() if line.strip()]
    records = [r for r in records if isinstance(r.get("boxes"), list) and r["boxes"]]
    print(f"{len(records)} usable frames (with >=1 truck)")

    random.seed(SEED)
    random.shuffle(records)
    n_val = max(1, int(len(records) * VAL_FRACTION))
    splits = {"val": records[:n_val], "train": records[n_val:]}

    for split, split_records in splits.items():
        images_dir = out_dir / "images" / split
        labels_dir = out_dir / "labels" / split
        images_dir.mkdir(parents=True, exist_ok=True)
        labels_dir.mkdir(parents=True, exist_ok=True)
        kept = dropped_boxes = 0
        for record in split_records:
            image = io.BytesIO(base64.b64decode(record["jpeg"]))
            name = f"{record['id']:06d}.jpg"
            lines = []
            for box in record["boxes"]:
                w_px = box["w"] * record["width"]
                h_px = box["h"] * record["height"]
                if w_px < MIN_BOX_PX or h_px < MIN_BOX_PX:
                    dropped_boxes += 1
                    continue
                cx = box["x"] + box["w"] / 2
                cy = box["y"] + box["h"] / 2
                lines.append(f"0 {cx:.6f} {cy:.6f} {box['w']:.6f} {box['h']:.6f}")
            if not lines:
                continue
            (images_dir / name).write_bytes(image.getvalue())
            (labels_dir / name).with_suffix(".txt").write_text("\n".join(lines) + "\n")
            kept += 1
        print(f"{split}: {kept} images, {dropped_boxes} tiny boxes dropped")

    yaml_path = out_dir / "simtruck.yaml"
    yaml_path.write_text(
        f"path: {out_dir}\ntrain: images/train\nval: images/val\nnames:\n  0: truck\n"
    )
    print(f"wrote {yaml_path}")


if __name__ == "__main__":
    main()
