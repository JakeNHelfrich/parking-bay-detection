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
 *
 * `viewport` is the fitted 16:9 rect of the WebGL canvas inside the container
 * (see world.ts): normalized coordinates describe the rendered scene, which
 * occupies exactly that rect — NOT the full container when the window aspect
 * differs from 16:9. Mapping through the viewport keeps boxes and bays
 * aligned at any window size.
 */
export function bboxToPixelRect(
  bbox: readonly [number, number, number, number],
  viewport: PixelRect,
): PixelRect {
  const [nx, ny, nw, nh] = bbox;
  return {
    x: viewport.x + nx * viewport.w,
    y: viewport.y + ny * viewport.h,
    w: nw * viewport.w,
    h: nh * viewport.h,
  };
}
