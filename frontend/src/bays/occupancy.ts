/**
 * Pure bay-occupancy logic: matches truck detections against bay rects.
 *
 * All rects are normalized `[x, y, w, h]`, 0..1, origin top-left — the same
 * convention as wire bboxes, so no coordinate conversion happens here at
 * all. Only `cls === "truck"` detections count toward occupancy (adding
 * `car` would risk false positives on pickups — see AGENTS.md).
 */

import type { Detection } from '../net/protocol';
import type { BayDef } from './bay-defs';

export interface NormalizedRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Minimum IoU between a truck bbox and a bay rect to call the bay FULL. */
export const OCCUPANCY_IOU_THRESHOLD = 0.1;

/**
 * Bays grow by this margin (normalized units per edge) when matching, so a
 * truck whose bbox hangs slightly over the painted bay still matches.
 */
export const BAY_RECT_MARGIN = 0.005;

export function rectIoU(a: NormalizedRect, b: NormalizedRect): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const interW = x2 - x1;
  const interH = y2 - y1;
  if (interW <= 0 || interH <= 0) return 0;
  const inter = interW * interH;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

function toRect(rect: readonly [number, number, number, number]): NormalizedRect {
  return { x: rect[0], y: rect[1], w: rect[2], h: rect[3] };
}

function withMargin(rect: NormalizedRect, margin: number): NormalizedRect {
  return {
    x: Math.max(0, rect.x - margin),
    y: Math.max(0, rect.y - margin),
    w: Math.min(1, rect.x + rect.w + margin) - Math.max(0, rect.x - margin),
    h: Math.min(1, rect.y + rect.h + margin) - Math.max(0, rect.y - margin),
  };
}

function containsPoint(rect: NormalizedRect, cx: number, cy: number): boolean {
  return cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h;
}

export interface BayState {
  readonly bayId: number;
  readonly occupied: boolean;
}

/**
 * Computes per-bay occupancy via greedy IoU matching: candidate
 * (bay, truck) pairs are matched best-IoU-first, and each bay and each
 * truck is claimed at most once — one truck can never fill two bays.
 * A truck also matches when its bbox center falls inside the (margin-grown)
 * bay rect, which covers tall trucks whose bbox outgrows the small painted
 * bay rectangle.
 */
export function computeBayStates(
  bays: readonly BayDef[],
  detections: readonly Detection[],
): readonly BayState[] {
  const trucks = detections.filter((det) => det.cls === 'truck');
  interface Candidate {
    bayIndex: number;
    truckIndex: number;
    iou: number;
  }
  const grown = bays.map((bay) => withMargin(toRect(bay.rect), BAY_RECT_MARGIN));

  const candidates: Candidate[] = [];
  bays.forEach((_bay, bayIndex) => {
    trucks.forEach((truck, truckIndex) => {
      const rect = toRect(truck.bbox);
      const iou = rectIoU(grown[bayIndex], rect);
      const cx = rect.x + rect.w / 2;
      const cy = rect.y + rect.h / 2;
      if (iou >= OCCUPANCY_IOU_THRESHOLD || containsPoint(grown[bayIndex], cx, cy)) {
        candidates.push({ bayIndex, truckIndex, iou });
      }
    });
  });
  candidates.sort((a, b) => b.iou - a.iou);

  const matchedBays = new Set<number>();
  const matchedTrucks = new Set<number>();
  for (const candidate of candidates) {
    if (matchedBays.has(candidate.bayIndex) || matchedTrucks.has(candidate.truckIndex)) continue;
    matchedBays.add(candidate.bayIndex);
    matchedTrucks.add(candidate.truckIndex);
  }

  return bays.map((bay, index) => ({ bayId: bay.id, occupied: matchedBays.has(index) }));
}

/** Number of occupied bays, for the HUD count. */
export function countOccupied(states: readonly BayState[]): number {
  return states.filter((state) => state.occupied).length;
}
