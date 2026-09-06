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
  isErrorMessage,
  type DetectionsMessage,
} from '../net/protocol';
import { isStaleFrame } from '../net/stale-frame';
import { resolveDetectWsUrl } from '../net/ws-url';
import { loadBayLayout, bayMapVersion } from '../bays/bay-defs';
import { computeBayStates } from '../bays/occupancy';
import { BayStateTracker } from '../bays/transitions';
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

  // Confirmed-transition tracking (bead rzo.1): bay states are re-derived
  // every accepted frame; only transitions that hold for
  // TRANSITION_CONFIRMATION_FRAMES are reported to the server via `bayState`
  // batches. The frontend is the one place with the bay map — occupancy math
  // stays here (invariant 5); the server only records what it is told.
  const bayTracker = new BayStateTracker();

  const client = new DetectClient({
    url: wsUrl,
    captureWidth: CAPTURE_WIDTH,
    captureHeight: CAPTURE_HEIGHT,
    onMessage(message) {
      if (!isDetectionsMessage(message)) {
        if (isErrorMessage(message)) {
          // Protocol errors (e.g. malformed frame) keep the socket open; log only.
          console.warn('[detect] server error:', message.message);
        }
        // bayStateAck: receipt confirmation for a reported batch — nothing to do.
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
        // Fire-and-forget: the batch is dropped (never buffered) when the
        // socket is down; the tracker keeps its confirmed state, so no
        // duplicate report is sent once reconnected.
        const transitions = bayTracker.update(states);
        if (transitions.length > 0) {
          client.sendBayState(message.frameId, transitions);
        }
      }
    },
    onStatus(status: ConnectionStatus) {
      store.setConnectionStatus(status);
    },
  });
  // Dispose-before-load guard: if the sim is torn down before bays.json
  // resolves, the load callback must not (re)connect the closed client.
  let clientDisposed = false;
  teardown.push(() => {
    clientDisposed = true;
    client.close();
  });

  // Bay occupancy (M5): bays.json is data, not code — fetched at runtime from
  // public/, validated, and purely informational. A failed load just means no
  // bay overlay; detection keeps running.
  let bayLayout: Awaited<ReturnType<typeof loadBayLayout>> = null;
  void loadBayLayout().then((layout) => {
    if (layout === null) {
      console.warn('[bays] bays.json missing or invalid — bay overlay disabled');
    } else {
      bayLayout = layout;
      overlay.setBays(layout.bays);
      store.setBayLayout(layout);
      // Bay states are (re)derived on the next accepted detections message,
      // exactly as before this refactor.
      // Hello carries the map version (bead rzo.2): every occupancy episode
      // the server records is stamped with it, so layout changes over time
      // never corrupt history. bayState is only ever sent when bayLayout is
      // loaded, so the version is always known by the first report.
      client.bayMapVersion = bayMapVersion(layout.bays);
    }
    // Connect only after the bay map resolves (loaded or failed) so hello
    // carries the map version when one exists. The fetch is a tiny local
    // static file; a failed load still resolves and connects without one.
    if (!clientDisposed) client.connect();
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