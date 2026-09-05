/**
 * World-space layout of the simulated lot.
 *
 * Coordinates: Three.js world space, XZ plane, +Y up, origin at lot center.
 * The lane runs along the X axis; bays sit on the far (north) side,
 * perpendicular to it.
 *
 * NOTE: this is the *sim-side* geometry source for M1. The screen-space
 * normalized bay rects used for occupancy (`public/bays.json`) are an M5
 * concern and will be derived from / aligned with this layout there.
 */

export const LANE_WIDTH = 8;
export const LANE_LENGTH = 120;

export const BAY_WIDTH = 3.4; // extent along X
export const BAY_DEPTH = 8.4; // extent along Z (rigid truck 7.2 m + clearance)
export const BAY_GAP = 1.2; // clearance between neighboring bays along X
export const BAY_COUNT = 4;

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
  // Single far-side rank: north only. The BaySide union keeps 'south' so
  // bay-defs.ts stays compatible with data carrying south-side bays.
  for (let i = 0; i < BAY_COUNT; i++) {
    const x = (i - (BAY_COUNT - 1) / 2) * bayPitch;
    slots.push({ id: i, side: 'north', center: { x, z: -zOffset } });
  }
  return slots;
}