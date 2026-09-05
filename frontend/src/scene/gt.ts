import * as THREE from 'three';
import { FrameCapture, CAPTURE_HEIGHT, CAPTURE_WIDTH } from '../capture/frame-capture';
import type { World } from './world';
import type { TruckSimulator } from './truck-simulator';

/**
 * Dev-only ground-truth capture for dataset generation (activated by `?gt`).
 *
 * NOT part of the wire protocol or the demo pipeline: while active, the page
 * renders the sim as usual but skips the overlay/WebSocket client, and a
 * secondary loop pairs clean JPEG captures with exact truck bounding boxes
 * projected from the scene (single source of truth — no image-space
 * heuristics). Pairs are POSTed to a local collector (gt_collect.py) as
 * base64 JPEG + normalized top-left-origin boxes, ready for YOLO training.
 *
 * Coordinates: `vector.project(camera)` yields NDC; conversion to normalized
 * top-left canvas space is x = (ndc.x + 1) / 2, y = (1 - ndc.y) / 2 — the
 * documented direction for Three.js bottom-left → canvas top-left.
 */

export const GT_CAPTURE_MIN_INTERVAL_MS = 500; // ~2 fps dataset sampling
const GT_ENDPOINT = 'http://localhost:9999/frame';

export function isGroundTruthMode(): boolean {
  return new URLSearchParams(window.location.search).has('gt');
}

export interface GtBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Normalized top-left bounding boxes of every active truck, clipped to 0..1. */
export function truckNormalizedBoxes(
  meshes: readonly THREE.Object3D[],
  camera: THREE.Camera,
): GtBox[] {
  const boxes: GtBox[] = [];
  const box = new THREE.Box3();
  const corner = new THREE.Vector3();
  for (const mesh of meshes) {
    box.setFromObject(mesh);
    const { min, max } = box;
    let ndcMinX = Infinity;
    let ndcMaxX = -Infinity;
    let ndcMinY = Infinity;
    let ndcMaxY = -Infinity;
    let anyInFront = false;
    for (let i = 0; i < 8; i++) {
      corner.set(
        i & 1 ? max.x : min.x,
        i & 2 ? max.y : min.y,
        i & 4 ? max.z : min.z,
      );
      corner.project(camera);
      // NDC z > 1 means behind/far-clipped; a corner behind the camera would
      // corrupt the 2D extent, so only count boxes with all corners in front.
      if (corner.z > 1) {
        anyInFront = false;
        break;
      }
      anyInFront = true;
      ndcMinX = Math.min(ndcMinX, corner.x);
      ndcMaxX = Math.max(ndcMaxX, corner.x);
      ndcMinY = Math.min(ndcMinY, corner.y);
      ndcMaxY = Math.max(ndcMaxY, corner.y);
    }
    if (!anyInFront) continue;

    // NDC [-1,1] → normalized top-left canvas space (y flipped), then clip.
    const x = Math.max(0, (ndcMinX + 1) / 2);
    const x2 = Math.min(1, (ndcMaxX + 1) / 2);
    const y = Math.max(0, (1 - ndcMaxY) / 2);
    const y2 = Math.min(1, (1 - ndcMinY) / 2);
    const w = x2 - x;
    const h = y2 - y;
    if (w <= 0 || h <= 0) continue;
    boxes.push({ x, y, w, h });
  }
  return boxes;
}

/**
 * Replaces the demo pipeline in `?gt` mode: runs the same render loop
 * (simulator update + render) and additionally captures clean JPEG frames
 * paired with projected truck boxes, POSTing each pair to the collector.
 */
export function initGroundTruthCapture(world: World, simulator: TruckSimulator): void {
  const capture = new FrameCapture(
    CAPTURE_WIDTH,
    CAPTURE_HEIGHT,
    GT_CAPTURE_MIN_INTERVAL_MS,
  );
  let frameId = 0;
  let last = performance.now();

  const loop = (now: number): void => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    simulator.update(dt);
    world.render();

    const pending = capture.capture(world.domElement, frameId + 1, now);
    if (pending !== null) {
      frameId += 1;
      const boxes = truckNormalizedBoxes(simulator.truckMeshes(), world.camera);
      void pending.then((frame) => {
        const bytes = new Uint8Array(frame.data);
        let binary = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
        }
        const payload = JSON.stringify({
          id: frame.frameId,
          jpeg: btoa(binary),
          width: CAPTURE_WIDTH,
          height: CAPTURE_HEIGHT,
          boxes,
        });
        // Fire-and-forget: dataset collection must never stall the render.
        void fetch(GT_ENDPOINT, {
          method: 'POST',
          body: payload,
          headers: { 'Content-Type': 'text/plain' }, // simple request: no CORS preflight
        }).catch(() => {
          /* collector not running; keep rendering */
        });
      });
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
