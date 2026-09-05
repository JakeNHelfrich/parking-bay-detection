import './style.css';
import { FrameCapture, CAPTURE_HEIGHT, CAPTURE_WIDTH } from './capture/frame-capture';
import { DetectClient, type ConnectionStatus } from './net/detect-client';
import {
  isDetectionsMessage,
  type DetectionsMessage,
} from './net/protocol';
import { isStaleFrame } from './net/stale-frame';
import { loadBayLayout } from './bays/bay-defs';
import { computeBayStates } from './bays/occupancy';
import { Overlay } from './overlay/overlay';
import { createBayField } from './scene/bays';
import { TruckSimulator } from './scene/truck-simulator';
import { createWorld } from './scene/world';
import { initGroundTruthCapture, isGroundTruthMode } from './scene/gt';

const container = document.querySelector<HTMLDivElement>('#app');
if (!container) throw new Error('#app container missing from index.html');

const world = createWorld(container);
const bays = createBayField(world.scene);
const simulator = new TruckSimulator(world.scene, bays);

// Dev-only dataset capture (`?gt`): render the sim but replace the whole
// detection pipeline with ground-truth box export for YOLO fine-tuning.
if (isGroundTruthMode()) {
  initGroundTruthCapture(world, simulator);
} else {
  runDemoPipeline(container, world, simulator);
}

function runDemoPipeline(
  container: HTMLDivElement,
  world: ReturnType<typeof createWorld>,
  simulator: TruckSimulator,
): void {
  const overlay = new Overlay(container);

  // Normalized detections/bays describe the 16:9 scene, which world.ts renders
  // into a contain-fit letterboxed rect; map overlay pixels through that rect.
  const syncViewport = (): void => overlay.setViewport(world.viewport);
  syncViewport();
  window.addEventListener('resize', syncViewport);

  // --- Detection pipeline (M3) -------------------------------------------------
  // The render loop below stays strictly non-blocking: capture is throttled and
  // fire-and-forget, WS sends never await, and the overlay draws whatever latest
  // result exists. Stale results (frameId older than the latest captured frame)
  // are dropped, never queued.

  const envUrl: unknown = import.meta.env.VITE_DETECT_WS_URL;
  const wsUrl =
    typeof envUrl === 'string' && envUrl.length > 0 ? envUrl : 'ws://localhost:8000/ws/detect';

  const capture = new FrameCapture(CAPTURE_WIDTH, CAPTURE_HEIGHT);

  const client = new DetectClient({
    url: wsUrl,
    captureWidth: CAPTURE_WIDTH,
    captureHeight: CAPTURE_HEIGHT,
    onMessage(message) {
      if (!isDetectionsMessage(message)) {
        // Protocol errors (e.g. malformed frame) keep the socket open; log only.
        console.warn('[detect] server error:', message.message);
        return;
      }
      // Stale = not newer than the result the overlay already shows.
      const shownFrameId = latestDetections?.frameId ?? 0;
      if (isStaleFrame(message.frameId, shownFrameId)) return; // dropped, never queued
      latestDetections = message;
      overlay.setDetections(message);
      if (bayLayout !== null) overlay.setBayStates(computeBayStates(bayLayout.bays, message.detections));
    },
    onStatus(status: ConnectionStatus) {
      overlay.setStatus(status);
    },
  });
  client.connect();

  // Bay occupancy (M5): bays.json is data, not code — fetched at runtime from
  // public/, validated, and purely informational. A failed load just means no
  // bay overlay; detection keeps running.
  let bayLayout: Awaited<ReturnType<typeof loadBayLayout>> = null;
  void loadBayLayout().then((layout) => {
    if (layout === null) {
      console.warn('[bays] bays.json missing or invalid — bay overlay disabled');
      return;
    }
    bayLayout = layout;
    overlay.setBays(layout.bays);
  });

  let latestFrameId = 0;
  let latestDetections: DetectionsMessage | null = null;
  let capturesSinceFpsTick = 0;
  let lastFpsTickMs = performance.now();
  let captureFps = 0;

  /** Captures + sends at the throttle rate. Never blocks the render loop. */
  function maybeCaptureAndSend(now: number): void {
    const frameId = latestFrameId + 1;
    const pending = capture.capture(world.domElement, frameId, now);
    if (pending === null) return; // throttled or previous capture still in flight
    latestFrameId = frameId;
    capturesSinceFpsTick += 1;
    void pending.then((frame) => {
      // Dropped silently when the socket is not open; never buffered.
      client.sendFrame(frame.frameId, frame.data);
    });
  }

  function tickFps(now: number): void {
    if (now - lastFpsTickMs < 1000) return;
    captureFps = (capturesSinceFpsTick * 1000) / (now - lastFpsTickMs);
    capturesSinceFpsTick = 0;
    lastFpsTickMs = now;
  }

  // Render loop. Decoupled from inference by design: nothing here may await.
  let last = performance.now();
  function frame(now: number): void {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    simulator.update(dt);
    world.render();
    maybeCaptureAndSend(now);
    tickFps(now);
    overlay.setHud({
      frameId: latestDetections?.frameId ?? null,
      latencyMs: latestDetections?.latencyMs ?? null,
      inferenceMs: latestDetections?.inferenceMs ?? null,
      captureFps,
    });
    overlay.draw();
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}
