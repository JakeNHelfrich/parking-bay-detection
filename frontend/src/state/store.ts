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
import type { StableBayState } from '../bays/stabilizer';
import type { ConnectionStatus } from '../net/detect-client';
import type { BaySnapshotEntry, DetectionsMessage } from '../net/protocol';
import type { AlertSummary } from '../net/alerts-api';

/** Top-level view the shell renders: the live yard or the history board. */
export type AppView = 'live' | 'history';

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
  /**
   * Stabilized bay states (yp6.1): per-frame occupancy after time-based
   * debounce + hysteresis, each stamped with `sinceMs` set only on confirmed
   * transitions. May be empty before the first detections frame.
   */
  readonly bayStates: readonly StableBayState[];
  readonly hud: HudStats;
  /** True while the demo pipeline (render + capture loop) is running. */
  readonly simRunning: boolean;
  /** Which main region the shell renders (rzo.4): live yard or history. */
  readonly view: AppView;
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
  setBayStates(states: readonly StableBayState[]): void;
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
  /** Switches the main region between the live yard and the history board. */
  setView(view: AppView): void;
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
    view: 'live',
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
    setBayStates(states: readonly StableBayState[]): void {
      update({ bayStates: [...states] });
    },

    applyBaySnapshot(entries: readonly BaySnapshotEntry[]): void {
      if (entries.length === 0) return; // nothing recorded: keep current view
      const snapshotStates = new Map(
        entries.map((entry) => {
          // Episode open time (server clock) becomes the bay's `sinceMs` —
          // recorded provenance, not a re-derivation (invariant 5).
          const sinceMs = Date.parse(entry.since);
          return [
            entry.bayId,
            {
              bayId: entry.bayId,
              occupied: true,
              confidence: entry.confidence,
              sinceMs: Number.isFinite(sinceMs) ? sinceMs : Date.now(),
            } satisfies StableBayState,
          ] as const;
        }),
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
    setView(view: AppView): void {
      update({ view });
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
