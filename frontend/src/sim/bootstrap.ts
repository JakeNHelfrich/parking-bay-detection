/**
 * Imperative demo-pipeline bootstrap (sim + capture + detect + overlay).
 *
 * Extracted verbatim from the former `main.ts` entry when React became the
 * app shell (`src/main.tsx` → `<App/>`): the pipeline is imperative glue, not
 * component state. `mountSim` takes the container to mount into and the app
 * state store to publish to, and returns a dispose function that stops the
 * render loop, closes the WebSocket, and releases the WebGL context.
 */

import { FrameCapture, CAPTURE_HEIGHT, CAPTURE_WIDTH } from '../capture/frame-capture';
import { DetectClient, type ConnectionStatus } from '../net/detect-client';
import {
  isDetectionsMessage,
  type DetectionsMessage,
} from '../net/protocol';
import { isStaleFrame } from '../net/stale-frame';
import { resolveDetectWsUrl } from '../net/ws-url';
import { loadBayLayout } from '../bays/bay-defs';
import { computeBayStates } from '../bays/occupancy';
import { Overlay } from '../overlay/overlay';
import { createBayField } from '../scene/bays';
import { createDepotScenery } from '../scene/scenery';
import { TruckSimulator } from '../scene/truck-simulator';
import { createWorld } from '../scene/world';
import { initGroundTruthCapture, isGroundTruthMode } from '../scene/gt';
import type { AppStateStore } from '../state/store';

export function mountSim(container: HTMLElement, store: AppStateStore): () => void {
  // Sim lifecycle (bead 6kh): the store's `simRunning` starts false; the UI
  // toggles it. The pipeline below reads the latest snapshot every frame, so
  // no subscription is needed here and the render loop stays decoupled.
  const world = createWorld(container);
  const bays = createBayField(world.scene);
  createDepotScenery(world.scene, bays);
  const simulator = new TruckSimulator(world.scene, bays);

  // Dev-only dataset capture (`?gt`): render the sim but replace the whole
  // detection pipeline with ground-truth box export for YOLO fine-tuning.
  if (isGroundTruthMode()) {
    initGroundTruthCapture(world, simulator);
    // Dev-only path; teardown releases the three.js resources below.
    return () => world.dispose();
  }

  const teardown: Array<() => void> = [];
  const overlay = new Overlay(container);
  teardown.push(() => {
    overlay.dispose();
    container.querySelector('#overlay')?.remove();
  });

  // Normalized detections/bays describe the 16:9 scene, which world.ts renders
  // into a contain-fit letterboxed rect; the overlay maps pixels through that
  // rect. world.viewport is re-read every frame (world.ts reassigns the rect
  // object on panel resize), so no resize listener is needed here.

  // --- Detection pipeline (M3) -------------------------------------------------
  // The render loop below stays strictly non-blocking: capture is throttled and
  // fire-and-forget, WS sends never await, and the overlay draws whatever latest
  // result exists. Stale results (frameId older than the latest captured frame)
  // are dropped, never queued.

  // VITE_DETECT_WS_URL overrides (e.g. dev backend on :8000); otherwise the
  // client talks to the same origin it was served from (single-container deploys).
  const wsUrl = resolveDetectWsUrl(import.meta.env.VITE_DETECT_WS_URL, window.location);

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
      store.setDetections(message);
      if (bayLayout !== null) {
        const states = computeBayStates(bayLayout.bays, message.detections);
        overlay.setBayStates(states);
        store.setBayStates(states);
      }
    },
    onStatus(status: ConnectionStatus) {
      store.setConnectionStatus(status);
    },
  });
  client.connect();
  teardown.push(() => client.close());

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
    store.setBayLayout(layout);
    // Bay states are (re)derived on the next accepted detections message,
    // exactly as before this refactor.
  });

  let latestFrameId = 0;
  let latestDetections: DetectionsMessage | null = null;
  let capturesSinceFpsTick = 0;
  let lastFpsTickMs = performance.now();
  let captureFps = 0;

  /** Captures + sends at the throttle rate. Never blocks the render loop. */
  function maybeCaptureAndSend(now: number): void {
    // Sim lifecycle: frames are captured/sent only while the sim is running.
    // Reading the immutable snapshot here keeps capture decoupled from the UI
    // (invariant 2) — no awaits, no UI dependency, just a boolean read.
    if (!store.getState().simRunning) return;
    // Reply-paced backpressure: skip capture while the previous frame's reply
    // is still in flight, so the effective rate is min(CAPTURE_FPS, server
    // throughput). Under a slow backend this bounds latency to ~1 inference
    // instead of streaming frames the server only coalesces away. Still
    // fire-and-forget — this is a skip check, never an await.
    if (client.awaitingReply) return;
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
  let rafId = 0;
  function frame(now: number): void {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    // Sim lifecycle: trucks only spawn/move while running; the world keeps
    // rendering (letterbox, overlay) so the shell stays alive.
    if (store.getState().simRunning) {
      simulator.update(dt);
    }
    world.render();
    maybeCaptureAndSend(now);
    tickFps(now);
    const hud = {
      frameId: latestDetections?.frameId ?? null,
      latencyMs: latestDetections?.latencyMs ?? null,
      inferenceMs: latestDetections?.inferenceMs ?? null,
      captureFps,
    };
    store.setHud(hud); // React UI is the HUD (header pill + health card).
    // Re-read the fitted rect every frame: world.ts may replace it on panel
    // resize, and the overlay must always map into the current 16:9 rect.
    overlay.setViewport(world.viewport);
    overlay.draw();
    rafId = requestAnimationFrame(frame);
  }
  teardown.push(() => cancelAnimationFrame(rafId));

  rafId = requestAnimationFrame(frame);

  return () => {
    for (const fn of teardown) fn();
    world.dispose();
  };
}