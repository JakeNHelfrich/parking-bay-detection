import { describe, expect, it } from 'vitest';
import { bboxToPixelRect, type PixelRect } from './coords';

describe('bboxToPixelRect', () => {
  it('scales normalized coordinates to display pixels', () => {
    expect(bboxToPixelRect([0.1, 0.5, 0.2, 0.25], { x: 0, y: 0, w: 960, h: 540 })).toEqual({
      x: 96,
      y: 270,
      w: 192,
      h: 135,
    });
  });

  it('preserves the top-left origin (no y-flip)', () => {
    // A box near the top of the frame (small normalized y) must land near
    // the top of the overlay canvas (small pixel y).
    const full = { x: 0, y: 0, w: 1920, h: 1080 };
    const top = bboxToPixelRect([0, 0.05, 0.5, 0.1], full);
    expect(top.y).toBeCloseTo(54);
    const bottom = bboxToPixelRect([0, 0.9, 0.5, 0.1], full);
    expect(bottom.y).toBeCloseTo(972);
    expect(bottom.y).toBeGreaterThan(top.y);
  });

  it('maps a full-frame box onto the full viewport', () => {
    expect(bboxToPixelRect([0, 0, 1, 1], { x: 0, y: 0, w: 1280, h: 720 })).toEqual({
      x: 0,
      y: 0,
      w: 1280,
      h: 720,
    });
  });

  it('maps into an offset letterboxed viewport (window wider than 16:9)', () => {
    // Container 1600×800 → fitted scene rect is 800*16/9 ≈ 1422 wide,
    // centered with x-offset ≈ 89. Normalized coords map inside it.
    const viewport: PixelRect = { x: 89, y: 0, w: 1422, h: 800 };
    const rect = bboxToPixelRect([0, 0, 1, 1], viewport);
    expect(rect).toEqual({ x: 89, y: 0, w: 1422, h: 800 });
    const quarter = bboxToPixelRect([0.5, 0.5, 0.25, 0.25], viewport);
    expect(quarter.x).toBeCloseTo(89 + 0.5 * 1422);
    expect(quarter.y).toBeCloseTo(400);
  });

  it('maps into a letterboxed viewport with a y-offset (window taller than 16:9)', () => {
    // Container 800×1000 → fitted rect is 800 wide, 450 tall, y-offset 275.
    const viewport: PixelRect = { x: 0, y: 275, w: 800, h: 450 };
    const rect = bboxToPixelRect([0, 0, 1, 1], viewport);
    expect(rect).toEqual({ x: 0, y: 275, w: 800, h: 450 });
    expect(bboxToPixelRect([0, 0.5, 0.1, 0.1], viewport).y).toBeCloseTo(275 + 225);
  });

  it('follows the viewport size, not the capture size', () => {
    // Same normalized box, different viewport sizes → proportional pixels.
    const a = bboxToPixelRect([0.25, 0.25, 0.5, 0.5], { x: 0, y: 0, w: 800, h: 600 });
    const b = bboxToPixelRect([0.25, 0.25, 0.5, 0.5], { x: 0, y: 0, w: 1600, h: 1200 });
    expect(a.w * 2).toBe(b.w);
    expect(a.h * 2).toBe(b.h);
  });
});
