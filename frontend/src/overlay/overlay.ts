import type { BayDef } from '../bays/bay-defs';
import type { BayState } from '../bays/occupancy';
import type { ConnectionStatus } from '../net/detect-client';
import { bboxToPixelRect } from './coords';
import type { DetectionsMessage } from '../net/protocol';

const BOX_COLOR = '#ffb020';
const BAY_EMPTY_COLOR = '#4caf50';
const BAY_FULL_COLOR = '#ff5252';
const LABEL_BG = 'rgba(0, 0, 0, 0.65)';
const HUD_COLOR = 'rgba(255, 255, 255, 0.92)';
const OFFLINE_COLOR = '#ff5252';
const FONT = '12px ui-monospace, SFMono-Regular, Menlo, monospace';

export interface HudStats {
  /** frameId of the latest accepted (non-stale) detection result. */
  readonly frameId: number | null;
  readonly latencyMs: number | null;
  readonly inferenceMs: number | null;
  readonly captureFps: number;
}

/**
 * The single overlay canvas: a 2D canvas layered above the WebGL canvas,
 * drawn in display-pixel space each animation frame from the latest
 * available detection result. Purely presentational — it never blocks on or
 * awaits inference, and simply keeps drawing the last state while offline.
 */
export class Overlay {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private latest: DetectionsMessage | null = null;
  private status: ConnectionStatus = 'connecting';
  private stats: HudStats = { frameId: null, latencyMs: null, inferenceMs: null, captureFps: 0 };
  private bays: readonly BayDef[] = [];
  private bayStates: readonly BayState[] = [];

  private readonly container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'overlay';
    const ctx = this.canvas.getContext('2d');
    if (ctx === null) throw new Error('2D context unavailable for overlay canvas');
    this.ctx = ctx;
    container.appendChild(this.canvas);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setDetections(message: DetectionsMessage | null): void {
    this.latest = message;
  }

  setStatus(status: ConnectionStatus): void {
    this.status = status;
  }

  setHud(stats: HudStats): void {
    this.stats = stats;
  }

  /** Installs the bay geometry once `bays.json` has loaded. */
  setBays(bays: readonly BayDef[]): void {
    this.bays = bays;
  }

  /** Replaces the per-bay occupancy states for the latest detection result. */
  setBayStates(states: readonly BayState[]): void {
    this.bayStates = states;
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
    this.drawBays(width, height);
    this.drawDetections(width, height);
    this.drawHud();
  }

  private drawBays(width: number, height: number): void {
    if (this.bays.length === 0) return;
    const occupiedById = new Map(this.bayStates.map((state) => [state.bayId, state.occupied]));
    this.ctx.font = FONT;
    for (const bay of this.bays) {
      const occupied = occupiedById.get(bay.id) ?? false;
      const rect = bboxToPixelRect(bay.rect, width, height);
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

  private drawDetections(width: number, height: number): void {
    const message = this.latest;
    if (message === null) return;
    this.ctx.font = FONT;
    for (const det of message.detections) {
      const rect = bboxToPixelRect(det.bbox, width, height);
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

  private drawHud(): void {
    const { frameId, latencyMs, inferenceMs, captureFps } = this.stats;
    const latency = latencyMs === null ? '—' : `${latencyMs.toFixed(1)}ms`;
    const inference = inferenceMs === null ? '—' : `${inferenceMs.toFixed(1)}ms`;
    const frame = frameId === null ? '—' : `#${frameId}`;
    const detCount = this.latest?.detections.length ?? 0;
    const occupied = this.bayStates.filter((state) => state.occupied).length;
    const bays =
      this.bays.length === 0 ? '' : ` | bays: ${occupied}/${this.bays.length} FULL`;
    const line = `detect: ${this.status} | frame: ${frame} | latency: ${latency} | infer: ${inference} | capture: ${captureFps.toFixed(0)}fps | boxes: ${detCount}${bays}`;

    this.ctx.font = FONT;
    const metrics = this.ctx.measureText(line);
    this.ctx.fillStyle = LABEL_BG;
    this.ctx.fillRect(8, 8, metrics.width + 16, 22);
    this.ctx.fillStyle = this.status === 'online' ? HUD_COLOR : OFFLINE_COLOR;
    this.ctx.fillText(line, 16, 23);

    if (this.status !== 'online') {
      const banner = 'detection offline — reconnecting…';
      const bannerMetrics = this.ctx.measureText(banner);
      this.ctx.fillStyle = LABEL_BG;
      this.ctx.fillRect(8, 38, bannerMetrics.width + 16, 22);
      this.ctx.fillStyle = OFFLINE_COLOR;
      this.ctx.fillText(banner, 16, 53);
    }
  }
}
