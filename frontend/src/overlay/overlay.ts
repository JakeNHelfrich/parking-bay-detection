import type { BayDef } from '../bays/bay-defs';
import type { BayState } from '../bays/occupancy';
import { bboxToPixelRect, type PixelRect } from './coords';
import type { DetectionsMessage } from '../net/protocol';

const BOX_COLOR = '#ffb020';
const BAY_EMPTY_COLOR = '#4caf50';
const BAY_FULL_COLOR = '#ff5252';
const LABEL_BG = 'rgba(0, 0, 0, 0.65)';
const FONT = '12px ui-monospace, SFMono-Regular, Menlo, monospace';

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
    this.ctx.font = FONT;
    for (const bay of this.bays) {
      const occupied = occupiedById.get(bay.id) ?? false;
      const rect = bboxToPixelRect(bay.rect, this.viewport);
      this.ctx.strokeStyle = occupied ? BAY_FULL_COLOR : BAY_EMPTY_COLOR;
      this.ctx.lineWidth = 2;
      this.ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
      const label = `${bay.id} ${occupied ? 'FULL' : 'EMPTY'}`;
      const metrics = this.ctx.measureText(label);
      this.ctx.fillStyle = LABEL_BG;
      this.ctx.fillRect(rect.x - 1, rect.y + rect.h + 2, metrics.width + 6, 14);
      this.ctx.fillStyle = occupied ? BAY_FULL_COLOR : BAY_EMPTY_COLOR;
      this.ctx.fillText(label, rect.x + 2, rect.y + rect.h + 13);
    }
  }

  private drawDetections(): void {
    const message = this.latest;
    if (message === null) return;
    this.ctx.font = FONT;
    for (const det of message.detections) {
      const rect = bboxToPixelRect(det.bbox, this.viewport);
      this.ctx.strokeStyle = BOX_COLOR;
      this.ctx.lineWidth = 2;
      this.ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
      const label = `${det.cls} ${(det.conf * 100).toFixed(0)}%`;
      const metrics = this.ctx.measureText(label);
      const labelY = rect.y > 16 ? rect.y - 14 : rect.y + rect.h + 14;
      this.ctx.fillStyle = LABEL_BG;
      this.ctx.fillRect(rect.x, labelY - 11, metrics.width + 8, 15);
      this.ctx.fillStyle = BOX_COLOR;
      this.ctx.fillText(label, rect.x + 4, labelY + 1);
    }
  }
}
