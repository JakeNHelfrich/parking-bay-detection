"""Local ground-truth collector for the `?gt` frontend debug mode.

Run this, then open http://localhost:5173/?gt=1 — the page POSTs one JSON
record per captured frame: {id, jpeg (base64), width, height, boxes}. Records
are appended to a JSONL file until the process is stopped (Ctrl+C).
That JSONL is the input to `make_yolo_dataset.py` and, ultimately,
`train_simtruck.py` — see that script's docstring for the full recipe.

Usage: python scripts/gt_collect.py [output.jsonl]
"""

from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

OUTPUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/simtruck-gt/raw.jsonl"


class Collector(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        try:
            record = json.loads(body)
            if not isinstance(record, dict) or "jpeg" not in record:
                raise ValueError("missing jpeg field")
        except (ValueError, json.JSONDecodeError):
            self.send_response(400)
            self.end_headers()
            return
        with open(OUTPUT, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record) + "\n")
        self.send_response(204)
        self.end_headers()

    def log_message(self, fmt: str, *args: object) -> None:
        # Quiet: one dot per frame keeps progress visible without spam.
        print(".", end="", flush=True)


if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", 9999), Collector)
    print(f"collecting → {OUTPUT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
