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

const layout: BayLayout = { version: 1, bays: [{ id: 0, side: 'north', rect: [0.1, 0.1, 0.2, 0.2] }] };

const hud: HudStats = { frameId: 42, latencyMs: 88, inferenceMs: 71, captureFps: 11.5 };

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

  it('setBayLayout / setBayStates publish independently', () => {
    const store = createAppStateStore();
    store.setBayLayout(layout);
    store.setBayStates([{ bayId: 0, occupied: true }]);
    const state = store.getState();
    expect(state.bayLayout).toBe(layout);
    expect(state.bayStates).toEqual([{ bayId: 0, occupied: true }]);
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
});
