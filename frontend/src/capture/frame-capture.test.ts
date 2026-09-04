import { describe, expect, it } from 'vitest';
import {
  CAPTURE_FPS,
  CAPTURE_HEIGHT,
  CAPTURE_WIDTH,
  shouldStartCapture,
} from './frame-capture';

describe('shouldStartCapture', () => {
  it('allows the first capture immediately', () => {
    expect(shouldStartCapture(1000, Number.NEGATIVE_INFINITY, 83.3, false)).toBe(true);
  });

  it('skips while a previous capture is in flight (toBlob is async)', () => {
    expect(shouldStartCapture(2000, 1000, 83.3, true)).toBe(false);
  });

  it('skips when inside the throttle interval', () => {
    expect(shouldStartCapture(1050, 1000, 83.3, false)).toBe(false);
  });

  it('allows capture once the interval has elapsed', () => {
    expect(shouldStartCapture(1084, 1000, 83.3, false)).toBe(true);
  });

  it('keeps the capture rate near the configured fps', () => {
    expect(CAPTURE_FPS).toBeGreaterThanOrEqual(10);
    expect(CAPTURE_FPS).toBeLessThanOrEqual(15);
  });

  it('uses a fixed capture resolution independent of the window', () => {
    expect(CAPTURE_WIDTH).toBe(960);
    expect(CAPTURE_HEIGHT).toBe(540);
  });
});
