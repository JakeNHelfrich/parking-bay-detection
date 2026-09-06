/**
 * Alert polling glue (bead rzo.5) — imperative, like the sim bootstrap.
 *
 * The in-app notification surface reads `alerts` from the store; this module
 * is the publisher: it polls the alerts REST surface on an interval, publishes
 * snapshots (or an error flag on failure), and performs acknowledgements.
 * Polling is independent of the sim lifecycle — the yard's record is live
 * whether or not the render loop is running.
 */

import { type AlertsClient, type AlertSummary } from '../net/alerts-api';
import type { AppStateStore } from '../state/store';

/** Poll cadence for the notification area. A constant, not a magic number. */
export const ALERT_POLL_INTERVAL_MS = 15_000;

export interface AlertPolling {
  /** Optimistically remove one alert from the UI, then acknowledge remotely. */
  acknowledge(id: number): void;
  dispose(): void;
}

/** Starts polling immediately (then every ALERT_POLL_INTERVAL_MS). */
export function startAlertPolling(store: AppStateStore, client: AlertsClient): AlertPolling {
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  async function poll(): Promise<void> {
    if (inFlight) return; // never queue overlapping polls
    inFlight = true;
    try {
      const alerts: AlertSummary[] = await client.fetchUnacknowledged();
      store.setAlerts(alerts);
    } catch (error) {
      store.setAlertsError(error instanceof Error ? error.message : String(error));
    } finally {
      inFlight = false;
    }
  }

  // Immediate first fetch, then the interval cadence.
  void poll();
  timer = setInterval(() => void poll(), ALERT_POLL_INTERVAL_MS);

  return {
    acknowledge(id: number): void {
      // Optimistic UI: drop the alert immediately; a failed ack surfaces on
      // the next poll, which restores the authoritative list from the record.
      store.removeAlert(id);
      void client.acknowledge(id).catch(() => store.setAlertsError('alert ack failed'));
    },

    dispose(): void {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
