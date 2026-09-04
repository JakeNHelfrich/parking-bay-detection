export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Converts a normalized wire bbox `[x, y, w, h]` (0..1, origin TOP-LEFT) into
 * display-pixel space for the 2D overlay canvas.
 *
 * Direction of conversion: wire (top-left, normalized) → overlay pixels
 * (top-left). Both spaces share a top-left origin, so this is a direct
 * scale — deliberately NO y-flip. Three.js's bottom-left origin is confined
 * to the scene layer and never reaches normalized coordinates or pixels.
 * Display size (not capture size) is used here, so window resizes only
 * affect this multiplication.
 */
export function bboxToPixelRect(
  bbox: readonly [number, number, number, number],
  displayWidth: number,
  displayHeight: number,
): PixelRect {
  const [nx, ny, nw, nh] = bbox;
  return {
    x: nx * displayWidth,
    y: ny * displayHeight,
    w: nw * displayWidth,
    h: nh * displayHeight,
  };
}
