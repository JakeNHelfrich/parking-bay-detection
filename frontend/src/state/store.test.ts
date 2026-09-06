import { describe, expect, it } from 'vitest';
import type { BayLayout } from '../bays/bay-defs';
import type { DetectionsMessage } from '../net/protocol';
import { createAppStateStore, type HudStats } from './store';

const detections: DetectionsMessage = {
  type: 'detections',
  frameId: 42,
  latencyMs: 88,
  inferenceMs: 71,
  detections: [{ cls: 'truck', conf: 0.95, bbox: [0.1, 0.1, 0.2, 0.2] }],
};

/** Epoch ms for the snapshot fixture episode's server-clock open time. */
const T_FIX = Date.parse('2026-09-06T08:00:00+00:00');

const layout: BayLayout = { version: 1, bays: [{ id: 0, side: 'north', rect: [0.1, 0.1, 0.2, 0.2] }] };

const hud: HudStats = { frameId: 42, latencyMs: 88, inferenceMs: 71, captureFps: 11.5 };

const alert = {
  id: 7,
  bayId: 2,
  rule: 'overstay',
  since: '2026-09-06T08:00:00+00:00',
  raisedAt: '2026-09-06T12:00:00+00:00',
  acknowledged: false,
  detail: { dwellMinutes: 240, elapsedMinutes: 245.5, stillOpen: true },
} as const;

describe('createAppStateStore', () => {
  it('starts with a defined initial state', () => {
    const store = createAppStateStore();
    const state = store.getState();
    expect(state.connectionStatus).toBe('connecting');
    expect(state.latestDetections).toBeNull();
    expect(state.bayLayout).toBeNull();
    expect(state.bayStates).toEqual([]);
    expect(state.hud).toEqual({ frameId: null, latencyMs: null, inferenceMs: null, captureFps: 0 });
    expect(state.simRunning).toBe(false);
    expect(state.view).toBe('live');
    expect(state.alerts).toEqual([]);
    expect(state.alertsError).toBeNull();
  });

  it('getState returns a new reference after each publish, stable between them', () => {
    const store = createAppStateStore();
    expect(store.getState()).toBe(store.getState());
    const before = store.getState();
    store.setConnectionStatus('online');
    expect(store.getState()).not.toBe(before); // replaced on publish
    const after = store.getState();
    expect(store.getState()).toBe(after);
  });

  it('setDetections publishes the message without mutating other fields', () => {
    const store = createAppStateStore();
    store.setDetections(detections);
    const state = store.getState();
    expect(state.latestDetections).toBe(detections);
    expect(state.connectionStatus).toBe('connecting');
    expect(state.simRunning).toBe(false);
  });

  it('setDetections stamps a receipt time for the trust check (yp6.3)', () => {
    const store = createAppStateStore();
    expect(store.getState().detectionsAtMs).toBeNull(); // no evidence yet
    const before = Date.now();
    store.setDetections(detections);
    const stamped = store.getState().detectionsAtMs;
    expect(stamped).not.toBeNull();
    expect(stamped!).toBeGreaterThanOrEqual(before);
    expect(stamped!).toBeLessThanOrEqual(Date.now());
  });

  it('setBayLayout / setBayStates publish independently', () => {
    const store = createAppStateStore();
    store.setBayLayout(layout);
    store.setBayStates([{ bayId: 0, occupied: true, sinceMs: T_FIX }]);
    const state = store.getState();
    expect(state.bayLayout).toBe(layout);
    expect(state.bayStates).toEqual([{ bayId: 0, occupied: true, sinceMs: T_FIX }]);
  });

  it('setHud replaces the whole hud snapshot', () => {
    const store = createAppStateStore();
    store.setHud(hud);
    expect(store.getState().hud).toBe(hud);
  });

  it('setConnectionStatus tracks status transitions', () => {
    const store = createAppStateStore();
    store.setConnectionStatus('online');
    expect(store.getState().connectionStatus).toBe('online');
    store.setConnectionStatus('offline');
    expect(store.getState().connectionStatus).toBe('offline');
  });

  it('setSimRunning toggles the flag', () => {
    const store = createAppStateStore();
    store.setSimRunning(true);
    expect(store.getState().simRunning).toBe(true);
    store.setSimRunning(false);
    expect(store.getState().simRunning).toBe(false);
  });

  it('notifies subscribers on every publish, in order', () => {
    const store = createAppStateStore();
    const events: string[] = [];
    const unsub = store.subscribe(() => events.push('a'));
    store.subscribe(() => events.push('b'));
    store.setConnectionStatus('online');
    expect(events).toEqual(['a', 'b']);
    unsub();
    store.setConnectionStatus('offline');
    expect(events).toEqual(['a', 'b', 'b']); // first publish: a+b; second: only b
  });

  it('unsubscribing twice is safe', () => {
    const store = createAppStateStore();
    let calls = 0;
    const unsub = store.subscribe(() => {
      calls += 1;
    });
    unsub();
    unsub();
    store.setHud(hud);
    expect(calls).toBe(0);
  });

  it('notifies a subscriber that unsubscribes during its own callback exactly once', () => {
    const store = createAppStateStore();
    let calls = 0;
    const unsub = store.subscribe(() => {
      calls += 1;
      unsub();
    });
    store.setDetections(detections);
    store.setDetections({ ...detections, frameId: 43 });
    expect(calls).toBe(1);
  });

  describe('view switching (rzo.4)', () => {
    it('toggles between the live yard and the history board', () => {
      const store = createAppStateStore();
      store.setView('history');
      expect(store.getState().view).toBe('history');
      store.setView('live');
      expect(store.getState().view).toBe('live');
    });

    it('keeps other state untouched across a view switch', () => {
      const store = createAppStateStore();
      store.setSimRunning(true);
      store.setView('history');
      expect(store.getState().simRunning).toBe(true); // sim state survives; remounts on return
    });
  });

  describe('applyBaySnapshot (rzo.6)', () => {
    const entry = (bayId: number, confidence?: number) => ({
      bayId,
      since: '2026-09-06T08:00:00+00:00',
      dwellSeconds: 300,
      confidence,
      mapVersion: 'feedface',
    });

    it('marks recorded bays occupied and leaves unmentioned bays alone', () => {
      const store = createAppStateStore();
      store.setBayStates([
        { bayId: 0, occupied: false, confidence: undefined, sinceMs: T_FIX - 1000 },
        { bayId: 1, occupied: true, confidence: 0.5, sinceMs: T_FIX - 2000 },
      ]);
      store.applyBaySnapshot([entry(1, 0.9), entry(3)]);
      const states = store.getState().bayStates;
      expect(states).toEqual([
        { bayId: 0, occupied: false, confidence: undefined, sinceMs: T_FIX - 1000 }, // untouched
        { bayId: 1, occupied: true, confidence: 0.9, sinceMs: T_FIX }, // refreshed by record
        { bayId: 3, occupied: true, confidence: undefined, sinceMs: T_FIX }, // new from record
      ]);
    });

    it('treats an empty snapshot as "nothing recorded", not "everything empty"', () => {
      const store = createAppStateStore();
      store.setBayStates([{ bayId: 0, occupied: true, confidence: 0.8, sinceMs: T_FIX }]);
      store.applyBaySnapshot([]);
      expect(store.getState().bayStates).toEqual([
        { bayId: 0, occupied: true, confidence: 0.8, sinceMs: T_FIX },
      ]);
    });

    it('does not touch the alerts surface', () => {
      const store = createAppStateStore();
      store.applyBaySnapshot([entry(2)]);
      expect(store.getState().alerts).toEqual([]);
    });
  });

  describe('alerts (rzo.5)', () => {
    it('setAlerts publishes a snapshot copy and clears the error', () => {
      const store = createAppStateStore();
      store.setAlertsError('boom');
      store.setAlerts([alert]);
      const state = store.getState();
      expect(state.alerts).toEqual([alert]);
      expect(state.alerts).not.toBe([alert]); // copied, not aliased
      expect(state.alertsError).toBeNull();
    });

    it('setAlertsError records the failure without touching alerts', () => {
      const store = createAppStateStore();
      store.setAlerts([alert]);
      store.setAlertsError('boom');
      expect(store.getState().alertsError).toBe('boom');
      expect(store.getState().alerts).toEqual([alert]);
    });

    it('removeAlert drops exactly the acknowledged id (optimistic ack)', () => {
      const store = createAppStateStore();
      const other = { ...alert, id: 8, bayId: 3 };
      store.setAlerts([alert, other]);
      store.removeAlert(7);
      expect(store.getState().alerts).toEqual([other]);
      store.removeAlert(999); // unknown id is a no-op
      expect(store.getState().alerts).toEqual([other]);
    });
  });
});
