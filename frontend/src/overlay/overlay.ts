import type { BayDef } from '../bays/bay-defs';
import type { BayState } from '../bays/occupancy';
import { bboxToPixelRect, type PixelRect } from './coords';
import type { DetectionsMessage } from '../net/protocol';

const BOX_COLOR = '#ffb020';
const BAY_EMPTY_COLOR = '#4caf50';
const BAY_FULL_COLOR = '#ff5252';
const LABEL_BG = 'rgba(0, 0, 0, 0.65)';
const FONT_STACK = 'ui-monospace, SFMono-Regular, Menlo, monospace';
/** Reference viewport width for the scale-aware overlay font (mockup drawOverlay). */
const SCALE_REFERENCE_WIDTH = 960;

/** Scale-aware overlay font: readable when the contain-fit rect is small. */
export function overlayFont(viewportWidth: number): string {
  const scale = viewportWidth / SCALE_REFERENCE_WIDTH;
  const px = Math.max(9, Math.round(11 * scale));
  return `600 ${px}px ${FONT_STACK}`;
}

/**
 * Bay label variants: a compact full form ('01 CLEAR') and a number-only
 * short form ('01') used when the projected quad is too narrow for the full
 * text without overrunning a neighbour (mockup uses the compact full form).
 */
export function bayLabelTexts(bayId: number, occupied: boolean): { full: string; short: string } {
  const num = String(bayId + 1).padStart(2, '0');
  return { full: `${num} ${occupied ? 'OCC' : 'CLEAR'}`, short: num };
}

/**
 * Pixel distance from `centers[index]` to the nearest other bay centre —
 * the widest a centred label can be without touching a neighbour's label.
 * Infinity when the bay has no neighbours.
 */
export function labelBudget(centers: readonly number[], index: number): number {
  let budget = Number.POSITIVE_INFINITY;
  for (let i = 0; i < centers.length; i++) {
    if (i === index) continue;
    budget = Math.min(budget, Math.abs(centers[i] - centers[index]));
  }
  return budget;
}

/**
 * The single overlay canvas: a 2D canvas layered above the WebGL canvas,
 * drawn in display-pixel space each animation frame from the latest
 * available detection result. Purely presentational — it never blocks on or
 * awaits inference; it keeps drawing the latest state regardless of
 * connection status. It renders ONLY detection boxes and bay rects: status
 * surfaces in the header pill and latency/fps in the sidebar inference
 * health card — the React UI is the HUD.
 */
export class Overlay {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private latest: DetectionsMessage | null = null;
  private bays: readonly BayDef[] = [];
  private bayStates: readonly BayState[] = [];
  /** Fitted 16:9 scene rect inside the container; normalized coords map here. */
  private viewport: PixelRect = { x: 0, y: 0, w: 0, h: 0 };

  private readonly container: HTMLElement;
  /** Observes the container (viewport panel); see constructor. */
  private readonly resizeObserver: ResizeObserver;

  constructor(container: HTMLElement) {
    this.container = container;
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'overlay';
    const ctx = this.canvas.getContext('2d');
    if (ctx === null) throw new Error('2D context unavailable for overlay canvas');
    this.ctx = ctx;
    container.appendChild(this.canvas);
    this.resize();
    // Observe the container, not the window: the panel can resize without a
    // window resize (shell layout changes), and normalized coordinates only
    // make sense against the panel's own pixel size.
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
  }

  /** Stops observing the container; call before removing the canvas. */
  dispose(): void {
    this.resizeObserver.disconnect();
  }

  setDetections(message: DetectionsMessage | null): void {
    this.latest = message;
  }

  /** Installs the bay geometry once `bays.json` has loaded. */
  setBays(bays: readonly BayDef[]): void {
    this.bays = bays;
  }

  /** Replaces the per-bay occupancy states for the latest detection result. */
  setBayStates(states: readonly BayState[]): void {
    this.bayStates = states;
  }

  /** Installs the fitted 16:9 scene rect that normalized coordinates map into. */
  setViewport(viewport: PixelRect): void {
    this.viewport = viewport;
  }

  resize(): void {
    this.canvas.width = this.container.clientWidth;
    this.canvas.height = this.container.clientHeight;
    this.draw();
  }

  /** Redraws the overlay from the latest state. Called once per animation frame. */
  draw(): void {
    const { width, height } = this.canvas;
    this.ctx.clearRect(0, 0, width, height);
    this.drawBays();
    this.drawDetections();
  }

  private drawBays(): void {
    if (this.bays.length === 0) return;
    const occupiedById = new Map(this.bayStates.map((state) => [state.bayId, state.occupied]));
    // Mockup drawOverlay(): at the head-on camera the projected quads are wide
    // and short and sit adjacent in X, so left-anchored labels below each quad
    // overrun their neighbours. Centre a compact label inside the bay mouth
    // instead, with a scale-aware font, and drop the status word when the
    // label would be wider than the distance to the nearest neighbour's
    // centre (labels stay clear of each other at every window aspect).
    const scale = Math.max(this.viewport.w, 1) / SCALE_REFERENCE_WIDTH;
    const fontPx = Math.max(9, Math.round(11 * scale));
    this.ctx.font = overlayFont(this.viewport.w);
    const rects = this.bays.map((bay) => bboxToPixelRect(bay.rect, this.viewport));
    const centers = rects.map((rect) => rect.x + rect.w / 2);
    for (let i = 0; i < this.bays.length; i++) {
      const bay = this.bays[i];
      const rect = rects[i];
      const occupied = occupiedById.get(bay.id) ?? false;
      this.ctx.strokeStyle = occupied ? BAY_FULL_COLOR : BAY_EMPTY_COLOR;
      this.ctx.lineWidth = 2;
      this.ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);

      const { full, short } = bayLabelTexts(bay.id, occupied);
      const fullW = this.ctx.measureText(full).width;
      const budget = labelBudget(centers, i);
      const label = fullW + 9 * scale > budget ? short : full;
      const textW = this.ctx.measureText(label).width;
      // Mouth edge of the quad = its bottom in screen space; the pill sits
      // just above that line, centred on the quad.
      const cx = centers[i];
      const cy = rect.y + rect.h;
      const boxW = textW + 9 * scale;
      const boxH = fontPx + 6 * scale;
      this.ctx.fillStyle = LABEL_BG;
      this.ctx.fillRect(cx - boxW / 2, cy - boxH - 3 * scale, boxW, boxH);
      this.ctx.fillStyle = occupied ? BAY_FULL_COLOR : BAY_EMPTY_COLOR;
      this.ctx.fillText(label, cx - textW / 2, cy - 7 * scale);
    }
  }

  private drawDetections(): void {
    const message = this.latest;
    if (message === null) return;
    const scale = Math.max(this.viewport.w, 1) / SCALE_REFERENCE_WIDTH;
    this.ctx.font = overlayFont(this.viewport.w);
    // Mockup drawOverlay(): vehicle tags are staggered by parity so adjacent
    // trucks' labels do not collide. Detections carry no bay id, so stagger
    // by x-order rank instead (deterministic for a given frame).
    const ranked = message.detections
      .map((det, index) => ({ det, index, rect: bboxToPixelRect(det.bbox, this.viewport) }))
      .sort((a, b) => a.rect.x + a.rect.w / 2 - (b.rect.x + b.rect.w / 2));
    for (let rank = 0; rank < ranked.length; rank++) {
      const { det, rect } = ranked[rank];
      this.ctx.strokeStyle = BOX_COLOR;
      this.ctx.lineWidth = 2;
      this.ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
      const label = `${det.cls} ${(det.conf * 100).toFixed(0)}%`;
      const metrics = this.ctx.measureText(label);
      const lift = (rank % 2) * (11 * scale + 8 * scale);
      const labelY = rect.y > 16 ? rect.y - 14 - lift : rect.y + rect.h + 14 + lift;
      this.ctx.fillStyle = LABEL_BG;
      this.ctx.fillRect(rect.x, labelY - 11, metrics.width + 8, 15);
      this.ctx.fillStyle = BOX_COLOR;
      this.ctx.fillText(label, rect.x + 4, labelY + 1);
    }
  }
}
