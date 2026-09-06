/**
 * Alert polling glue tests (bead rzo.5) — fake timers + a stub client.
 * Pins: immediate first fetch, no overlapping polls, error surfacing,
 * optimistic ack, and disposal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertSummary } from '../net/alerts-api';
import { ALERT_POLL_INTERVAL_MS, startAlertPolling } from './alert-polling';
import { createAppStateStore, type AppStateStore } from '../state/store';

const alert = (id: number): AlertSummary => ({
  id,
  bayId: 0,
  rule: 'overstay',
  since: '2026-09-06T08:00:00+00:00',
  raisedAt: '2026-09-06T12:00:00+00:00',
  acknowledged: false,
  detail: {},
});

function stubClient(overrides: Partial<{ fetch: () => Promise<AlertSummary[]>; ack: () => Promise<void> }> = {}) {
  return {
    fetchUnacknowledged: vi.fn(overrides.fetch ?? (async () => [alert(1)])),
    acknowledge: vi.fn(overrides.ack ?? (async () => undefined)),
  };
}

describe('startAlertPolling', () => {
  let store: AppStateStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = createAppStateStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches immediately, then on the interval cadence', async () => {
    const client = stubClient();
    const polling = startAlertPolling(store, client);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(client.fetchUnacknowledged).toHaveBeenCalledTimes(1);
      expect(store.getState().alerts).toEqual([alert(1)]);
      await vi.advanceTimersByTimeAsync(ALERT_POLL_INTERVAL_MS);
      expect(client.fetchUnacknowledged).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(ALERT_POLL_INTERVAL_MS * 3);
      expect(client.fetchUnacknowledged).toHaveBeenCalledTimes(5);
    } finally {
      polling.dispose();
    }
  });

  it('skips a tick while the previous poll is still in flight', async () => {
    let release: ((alerts: AlertSummary[]) => void) = () => undefined;
    const client = stubClient({
      fetch: () =>
        new Promise<AlertSummary[]>((resolve) => {
          release = resolve;
        }),
    });
    const polling = startAlertPolling(store, client);
    try {
      const first = vi.advanceTimersByTimeAsync(0); // poll starts, hangs
      await vi.advanceTimersByTimeAsync(ALERT_POLL_INTERVAL_MS * 2);
      expect(client.fetchUnacknowledged).toHaveBeenCalledTimes(1); // no overlap
      release([alert(2)]);
      await first;
      expect(store.getState().alerts).toEqual([alert(2)]);
    } finally {
      polling.dispose();
    }
  });

  it('surfaces fetch failures via setAlertsError and recovers later', async () => {
    let fail = true;
    const client = stubClient({
      fetch: async () => {
        if (fail) throw new Error('backend down');
        return [alert(1)];
      },
    });
    const polling = startAlertPolling(store, client);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getState().alertsError).toBe('backend down');
      fail = false;
      await vi.advanceTimersByTimeAsync(ALERT_POLL_INTERVAL_MS);
      expect(store.getState().alertsError).toBeNull();
      expect(store.getState().alerts).toEqual([alert(1)]);
    } finally {
      polling.dispose();
    }
  });

  it('acknowledge removes optimistically and calls the client', async () => {
    const client = stubClient();
    store.setAlerts([alert(1), alert(2)]);
    const polling = startAlertPolling(store, client);
    try {
      polling.acknowledge(1);
      expect(store.getState().alerts.map((a) => a.id)).toEqual([2]); // optimistic
      expect(client.acknowledge).toHaveBeenCalledWith(1);
      await vi.advanceTimersByTimeAsync(0); // next poll restores the truth
    } finally {
      polling.dispose();
    }
  });

  it('acknowledge failure surfaces an error without throwing', async () => {
    const client = stubClient({
      ack: async () => {
        throw new Error('404');
      },
    });
    store.setAlerts([alert(1)]);
    const polling = startAlertPolling(store, client);
    try {
      polling.acknowledge(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getState().alertsError).toBe('alert ack failed');
    } finally {
      polling.dispose();
    }
  });

  it('dispose stops the cadence', async () => {
    const client = stubClient();
    const polling = startAlertPolling(store, client);
    await vi.advanceTimersByTimeAsync(0);
    polling.dispose();
    await vi.advanceTimersByTimeAsync(ALERT_POLL_INTERVAL_MS * 5);
    expect(client.fetchUnacknowledged).toHaveBeenCalledTimes(1);
  });
});
