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
import type { BaySnapshotEntry, DetectionsMessage } from '../net/protocol';
import type { AlertSummary } from '../net/alerts-api';

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
  /** Unacknowledged alerts from the durable record (polled REST, rzo.5). */
  readonly alerts: readonly AlertSummary[];
  /** Last alerts-fetch error message, or null while healthy. */
  readonly alertsError: string | null;
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
  /**
   * Merges a late-joiner `baySnapshot` (rzo.6) into `bayStates`: bays with a
   * recorded open episode become occupied; unmentioned bays keep whatever
   * state they already have. The next detections frame re-derives every bay
   * from live video and overwrites this — the snapshot is a connect-time
   * bridge, not a second occupancy authority.
   */
  applyBaySnapshot(entries: readonly BaySnapshotEntry[]): void;
  setHud(hud: HudStats): void;
  setSimRunning(running: boolean): void;
  setAlerts(alerts: readonly AlertSummary[]): void;
  setAlertsError(message: string | null): void;
  removeAlert(id: number): void;
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
    alerts: [],
    alertsError: null,
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

    applyBaySnapshot(entries: readonly BaySnapshotEntry[]): void {
      if (entries.length === 0) return; // nothing recorded: keep current view
      const snapshotStates = new Map(
        entries.map((entry) => [
          entry.bayId,
          { bayId: entry.bayId, occupied: true, confidence: entry.confidence } satisfies BayState,
        ]),
      );
      const merged = state.bayStates.map((existing) => snapshotStates.get(existing.bayId) ?? existing);
      for (const [bayId, state] of snapshotStates) {
        if (!merged.some((existing) => existing.bayId === bayId)) merged.push(state);
      }
      update({ bayStates: merged });
    },
    setHud(hud: HudStats): void {
      update({ hud });
    },
    setSimRunning(running: boolean): void {
      update({ simRunning: running });
    },
    setAlerts(alerts: readonly AlertSummary[]): void {
      update({ alerts: [...alerts], alertsError: null });
    },
    setAlertsError(message: string | null): void {
      update({ alertsError: message });
    },
    removeAlert(id: number): void {
      update({ alerts: state.alerts.filter((alert) => alert.id !== id) });
    },
  };
}
