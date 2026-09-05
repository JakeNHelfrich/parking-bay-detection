/** Fixed capture resolution. Independent of window size by design —
 * normalized coordinates on the wire must never leak capture dimensions. */
export const CAPTURE_WIDTH = 960;
export const CAPTURE_HEIGHT = 540;
/** Target capture rate while the scene renders at full frame rate. */
export const CAPTURE_FPS = 12;
export const CAPTURE_MIN_INTERVAL_MS = 1000 / CAPTURE_FPS;
export const JPEG_QUALITY = 0.8;

/**
 * Pure capture throttle: a new capture may start only when the previous
 * `toBlob` has settled (`inFlight === false`) AND at least `minIntervalMs`
 * has passed since the last capture start. Frames that fail this check are
 * skipped — never queued (toBlob is async and rate-limited).
 */
export function shouldStartCapture(
  nowMs: number,
  lastCaptureMs: number,
  minIntervalMs: number,
  inFlight: boolean,
): boolean {
  return !inFlight && nowMs - lastCaptureMs >= minIntervalMs;
}

export interface CapturedFrame {
  readonly frameId: number;
  readonly data: ArrayBuffer;
}

/**
 * Captures a source canvas (the WebGL renderer's output) to a fixed-size
 * JPEG via an offscreen 2D canvas. Origin note: the WebGL canvas is already
 * presented in TOP-LEFT canvas coordinates (three.js's bottom-left math
 * never leaves the GPU presentation), so `drawImage` is a 1:1 copy — only
 * scaling to CAPTURE_WIDTH×CAPTURE_HEIGHT, no y-flip. Downstream boxes stay
 * normalized with a top-left origin, so capture resolution never leaks.
 */
export class FrameCapture {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly minIntervalMs: number;
  private inFlight = false;
  private lastCaptureMs = Number.NEGATIVE_INFINITY;

  constructor(
    width: number = CAPTURE_WIDTH,
    height: number = CAPTURE_HEIGHT,
    minIntervalMs: number = CAPTURE_MIN_INTERVAL_MS,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (ctx === null) throw new Error('2D context unavailable for capture canvas');
    this.ctx = ctx;
    this.minIntervalMs = minIntervalMs;
  }

  get capturing(): boolean {
    return this.inFlight;
  }

  /**
   * Starts a throttled capture. Returns a promise resolving with the JPEG
   * bytes, or null when the capture was skipped (in flight or throttled).
   * Callers must not await the promise inside the render loop.
   */
  capture(
    source: HTMLCanvasElement,
    frameId: number,
    nowMs: number,
  ): Promise<CapturedFrame> | null {
    if (!shouldStartCapture(nowMs, this.lastCaptureMs, this.minIntervalMs, this.inFlight)) {
      return null;
    }
    this.inFlight = true;
    this.lastCaptureMs = nowMs;
    this.ctx.drawImage(source, 0, 0, this.canvas.width, this.canvas.height);
    return new Promise<CapturedFrame>((resolve) => {
      this.canvas.toBlob((blob) => {
        this.inFlight = false;
        if (blob === null) return; // encoding failed; the next due frame retries
        void blob.arrayBuffer().then((data) => resolve({ frameId, data }));
      }, 'image/jpeg', JPEG_QUALITY);
    });
  }
}
