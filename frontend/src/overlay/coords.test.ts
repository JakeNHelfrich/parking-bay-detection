import { describe, expect, it } from 'vitest';
import { bboxToPixelRect } from './coords';

describe('bboxToPixelRect', () => {
  it('scales normalized coordinates to display pixels', () => {
    expect(bboxToPixelRect([0.1, 0.5, 0.2, 0.25], 960, 540)).toEqual({
      x: 96,
      y: 270,
      w: 192,
      h: 135,
    });
  });

  it('preserves the top-left origin (no y-flip)', () => {
    // A box near the top of the frame (small normalized y) must land near
    // the top of the overlay canvas (small pixel y).
    const top = bboxToPixelRect([0, 0.05, 0.5, 0.1], 1920, 1080);
    expect(top.y).toBeCloseTo(54);
    const bottom = bboxToPixelRect([0, 0.9, 0.5, 0.1], 1920, 1080);
    expect(bottom.y).toBeCloseTo(972);
    expect(bottom.y).toBeGreaterThan(top.y);
  });

  it('maps a full-frame box onto the full canvas', () => {
    expect(bboxToPixelRect([0, 0, 1, 1], 1280, 720)).toEqual({ x: 0, y: 0, w: 1280, h: 720 });
  });

  it('follows the display size, not the capture size', () => {
    // Same normalized box, different window sizes → proportional pixels.
    const a = bboxToPixelRect([0.25, 0.25, 0.5, 0.5], 800, 600);
    const b = bboxToPixelRect([0.25, 0.25, 0.5, 0.5], 1600, 1200);
    expect(a.w * 2).toBe(b.w);
    expect(a.h * 2).toBe(b.h);
  });
});
