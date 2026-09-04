/**
 * World-space layout of the simulated lot.
 *
 * Coordinates: Three.js world space, XZ plane, +Y up, origin at lot center.
 * The lane runs along the X axis; bays sit on both sides, perpendicular to it.
 *
 * NOTE: this is the *sim-side* geometry source for M1. The screen-space
 * normalized bay rects used for occupancy (`public/bays.json`) are an M5
 * concern and will be derived from / aligned with this layout there.
 */

export const LANE_WIDTH = 6;
export const LANE_LENGTH = 120;

export const BAY_WIDTH = 3.2; // extent along X
export const BAY_DEPTH = 3.6; // extent along Z
export const BAY_GAP = 1.4; // clearance between neighboring bays along X
export const BAYS_PER_SIDE = 4;

/** Yaw (rotation.y) that parks a truck nose-out toward the lane. */
export function bayHeading(side: BaySide): number {
  return side === 'north' ? -Math.PI / 2 : Math.PI / 2;
}

export type BaySide = 'north' | 'south';

export interface BaySlot {
  id: number;
  side: BaySide;
  /** Bay center in world XZ. */
  center: { x: number; z: number };
}

export function baySlots(): BaySlot[] {
  const slots: BaySlot[] = [];
  const bayPitch = BAY_WIDTH + BAY_GAP;
  const zOffset = LANE_WIDTH / 2 + BAY_DEPTH / 2;
  let id = 0;
  for (const side of ['north', 'south'] as const) {
    const z = side === 'north' ? -zOffset : zOffset;
    for (let i = 0; i < BAYS_PER_SIDE; i++) {
      const x = (i - (BAYS_PER_SIDE - 1) / 2) * bayPitch;
      slots.push({ id, side, center: { x, z } });
      id++;
    }
  }
  return slots;
}