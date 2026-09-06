/**
 * YardBoard tests (yp6.4): the glanceable full-viewport board. Covers the
 * pure tile model (`yardTileCopy` — tone/headline/sub, reusing the detail
 * cards' tone + copy rules) and the store-driven render: one large tile per
 * bay, trust-gray tiles while the evidence stream can't back a claim, and
 * the dismiss control dispatching `setBoardOpen(false)`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAppStateStore, type AppStateStore } from '../state/store';
import { AppStateProvider } from '../state/react';
import type { BayLayout } from '../bays/bay-defs';
import type { DetectionsMessage } from '../net/protocol';
import { yardTileCopy, YardBoard } from './YardBoard';

/** Arbitrary fixture timestamp for stabilized bay states (epoch ms). */
const T_FIX = 1_700_000_000_000;

const layout: BayLayout = {
  version: 1,
  bays: [
    { id: 0, side: 'north', rect: [0.1, 0.1, 0.2, 0.2] },
    { id: 1, side: 'south', rect: [0.5, 0.5, 0.2, 0.2] },
  ],
};

const FRESH_DETECTIONS: DetectionsMessage = {
  type: 'detections',
  frameId: 1,
  latencyMs: 5,
  inferenceMs: 4,
  detections: [],
};

function renderWithStore(store: AppStateStore): string {
  return renderToStaticMarkup(
    createElement(AppStateProvider, {
      store,
      children: createElement(YardBoard),
    }),
  );
}

describe('yardTileCopy', () => {
  it('leads with the state word for a confirmed occupied bay, with the duration', () => {
    const state = { bayId: 0, occupied: true, confidence: 0.9, sinceMs: T_FIX - 6 * 60_000 };
    expect(yardTileCopy(state, T_FIX)).toEqual({
      tone: 'occupied',
      headline: 'Full',
      sub: 'for 6 min',
    });
  });

  it('leads with Free for a confirmed clear bay', () => {
    const state = { bayId: 0, occupied: false, confidence: 0.98, sinceMs: T_FIX };
    // Valid stamp at now -> "for under a min" (elapsed 0 floors up).
    expect(yardTileCopy(state, T_FIX)).toEqual({
      tone: 'clear',
      headline: 'Free',
      sub: 'for under a min',
    });
  });

  it('falls back to the detection copy when the state has no duration stamp', () => {
    const state = { bayId: 0, occupied: true, confidence: 0.9, sinceMs: Number.NaN };
    expect(yardTileCopy(state, T_FIX)).toMatchObject({ headline: 'Full', sub: 'truck detected' });
  });

  it('says Waiting before the sim starts — no claim, no duration', () => {
    const state = { bayId: 0, occupied: true, confidence: 0.9, sinceMs: T_FIX };
    expect(yardTileCopy(state, T_FIX, false, 'idle')).toEqual({
      tone: 'unknown',
      headline: 'Waiting',
      sub: 'start the simulation',
    });
  });

  it("reads the same Can't-confirm reasons as the detail cards (yp6.3 carry-over)", () => {
    const state = { bayId: 0, occupied: true, confidence: 0.9, sinceMs: T_FIX };
    expect(yardTileCopy(state, T_FIX, true, 'feed-stale')).toEqual({
      tone: 'unknown',
      headline: "Can't confirm",
      sub: 'detection feed stale',
    });
    expect(yardTileCopy(state, T_FIX, true, 'feed-offline')).toMatchObject({
      headline: "Can't confirm",
      sub: 'inference offline',
    });
    expect(yardTileCopy(state, T_FIX, true, 'no-data')).toMatchObject({
      sub: 'waiting for detections',
    });
    expect(yardTileCopy(undefined, T_FIX, true, null)).toMatchObject({
      sub: 'no data yet',
    });
  });

  it('grays a weak truck match instead of asserting Full', () => {
    const state = { bayId: 0, occupied: true, confidence: 0.2, sinceMs: T_FIX };
    expect(yardTileCopy(state, T_FIX)).toEqual({
      tone: 'unknown',
      headline: "Can't confirm",
      sub: 'weak truck match',
    });
  });
});

describe('YardBoard', () => {
  it('renders one large tile per bay in bays.json order', () => {
    const store = createAppStateStore();
    store.setBayLayout(layout);
    const html = renderWithStore(store);
    expect(html).toContain('Bay 01');
    expect(html).toContain('Bay 02');
    expect(html).toContain('Yard board');
  });

  it('shows confirmed state words with durations on a live stream', () => {
    const store = createAppStateStore();
    store.setBayLayout(layout);
    store.setSimRunning(true);
    store.setDetections(FRESH_DETECTIONS);
    store.setBayStates([
      { bayId: 0, occupied: true, confidence: 0.9, sinceMs: Date.now() - 6.5 * 60_000 },
      { bayId: 1, occupied: false, confidence: 0.95, sinceMs: T_FIX },
    ]);
    const html = renderWithStore(store);
    expect(html).toContain('Full');
    expect(html).toContain('for 6 min');
    expect(html).toContain('Free');
  });

  it('grays every tile while the feed is stale — no silent last-known claim', () => {
    vi.useFakeTimers();
    try {
      const store = createAppStateStore();
      store.setBayLayout(layout);
      store.setSimRunning(true);
      store.setDetections(FRESH_DETECTIONS);
      vi.advanceTimersByTime(6_000); // past DETECTIONS_STALE_AFTER_MS (5s)
      store.setBayStates([{ bayId: 0, occupied: true, confidence: 0.9, sinceMs: T_FIX }]);
      const html = renderWithStore(store);
      expect(html).toContain('detection feed stale'); // tile sub carries the bare reason
      expect(html).not.toContain('Full');
    } finally {
      vi.useRealTimers();
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});
