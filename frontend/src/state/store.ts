/**
 * Framework-agnostic observable app state store (UI boundary prep).
 *
 * `main.ts` (the pipeline) is the sole *publisher*; UI consumers subscribe
 * (directly, or via the React adapter in `./react.ts`). State is an immutable
 * snapshot — every setter replaces the whole `AppState` object and notifies
 * subscribers once. Nothing in here knows about three.js, the WebSocket, or
 * the DOM.
 */

import type { BayLayout } from '../bays/bay-defs';
import type { BayState } from '../bays/occupancy';
import type { ConnectionStatus } from '../net/detect-client';
import type { DetectionsMessage } from '../net/protocol';

/** HUD figures driving the React health card (latency/fps). */
export interface HudStats {
  readonly frameId: number | null;
  readonly latencyMs: number | null;
  readonly inferenceMs: number | null;
  readonly captureFps: number;
}

/** Immutable snapshot of everything UI-relevant. */
export interface AppState {
  readonly connectionStatus: ConnectionStatus;
  /** Latest accepted (non-stale) detections message, or null before the first. */
  readonly latestDetections: DetectionsMessage | null;
  /** Validated bay map from bays.json, or null when missing/invalid. */
  readonly bayLayout: BayLayout | null;
  /** Bay occupancy derived from `latestDetections` × `bayLayout` (may be stale-safe empty). */
  readonly bayStates: readonly BayState[];
  readonly hud: HudStats;
  /** True while the demo pipeline (render + capture loop) is running. */
  readonly simRunning: boolean;
}

export interface AppStateStore {
  /** Current immutable snapshot. Reference-stable between publishes. */
  getState(): AppState;
  /** Registers a listener; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  setConnectionStatus(status: ConnectionStatus): void;
  setDetections(message: DetectionsMessage): void;
  setBayLayout(layout: BayLayout): void;
  setBayStates(states: readonly BayState[]): void;
  setHud(hud: HudStats): void;
  setSimRunning(running: boolean): void;
}

const INITIAL_HUD: HudStats = {
  frameId: null,
  latencyMs: null,
  inferenceMs: null,
  captureFps: 0,
};

export function createAppStateStore(): AppStateStore {
  let state: AppState = {
    connectionStatus: 'connecting',
    latestDetections: null,
    bayLayout: null,
    bayStates: [],
    hud: INITIAL_HUD,
    simRunning: false,
  };
  const listeners = new Set<() => void>();

  function publish(next: AppState): void {
    state = next;
    for (const listener of [...listeners]) listener();
  }

  function update(patch: Partial<AppState>): void {
    publish({ ...state, ...patch });
  }

  return {
    getState: () => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setConnectionStatus(status: ConnectionStatus): void {
      update({ connectionStatus: status });
    },
    setDetections(message: DetectionsMessage): void {
      update({ latestDetections: message });
    },
    setBayLayout(layout: BayLayout): void {
      update({ bayLayout: layout });
    },
    setBayStates(states: readonly BayState[]): void {
      update({ bayStates: [...states] });
    },
    setHud(hud: HudStats): void {
      update({ hud });
    },
    setSimRunning(running: boolean): void {
      update({ simRunning: running });
    },
  };
}
