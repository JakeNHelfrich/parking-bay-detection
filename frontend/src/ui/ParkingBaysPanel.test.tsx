/**
 * ParkingBaysPanel tests (bead: parking bays sidebar panel; trust yp6.3).
 * Covers the pure formatters (label / status copy / tone) and the
 * store-driven render: bay list derives from bays.json data in the store,
 * state copy from bayStates, and "Can't confirm" whenever the evidence
 * stream (connection, detections age, per-bay match confidence) can't
 * back a claim.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAppStateStore, type AppStateStore } from '../state/store';
import { AppStateProvider } from '../state/react';
import type { BayLayout } from '../bays/bay-defs';
import type { DetectionsMessage } from '../net/protocol';
import { bayDurationCopy, bayLabel, bayStatusCopy, bayTone, ParkingBaysPanel } from './ParkingBaysPanel';

/** Arbitrary fixture timestamp for stabilized bay states (epoch ms). */
const T_FIX = 1_700_000_000_000;

/** Fresh evidence for live-card renders: panels derive trust from the
 * detectionsAtMs receipt stamp that setDetections publishes (yp6.3). */
const FRESH_DETECTIONS: DetectionsMessage = {
  type: 'detections',
  frameId: 1,
  latencyMs: 5,
  inferenceMs: 4,
  detections: [],
};

const layout: BayLayout = {
  version: 1,
  bays: [
    { id: 0, side: 'north', rect: [0.1, 0.1, 0.2, 0.2] },
    { id: 1, side: 'south', rect: [0.5, 0.5, 0.2, 0.2] },
    { id: 7, side: 'north', rect: [0.3, 0.1, 0.2, 0.2] },
  ],
};

function renderWithStore(store: AppStateStore): string {
  return renderToStaticMarkup(
    // AppStateProvider requires children in its props object (createElement).
    createElement(AppStateProvider, {
      store,
      children: createElement(ParkingBaysPanel),
    }),
  );
}

describe('bayLabel', () => {
  it('formats a bayId as a 1-based zero-padded label', () => {
    expect(bayLabel(0)).toBe('Bay 01');
    expect(bayLabel(1)).toBe('Bay 02');
    expect(bayLabel(7)).toBe('Bay 08');
    expect(bayLabel(11)).toBe('Bay 12');
  });
});

describe('bayStatusCopy', () => {
  it('renders the occupied copy', () => {
    expect(bayStatusCopy({ bayId: 1, occupied: true, confidence: 0.87 })).toBe(
      'Occupied · truck detected',
    );
  });

  it('renders the clear copy with the occupancy-confidence bead', () => {
    expect(bayStatusCopy({ bayId: 0, occupied: false, confidence: 0.984 })).toBe(
      'Clear · 98% confidence',
    );
  });

  it('reads Waiting to start while the sim is idle, regardless of state', () => {
    expect(bayStatusCopy({ bayId: 0, occupied: true }, false)).toBe('Waiting to start');
    expect(bayStatusCopy({ bayId: 0, occupied: false }, false)).toBe('Waiting to start');
  });

  it('renders live copy once the sim is running (default argument)', () => {
    expect(bayStatusCopy({ bayId: 0, occupied: true })).toBe('Occupied · truck detected');
  });

  it('renders a dash for confidence when the bay is unmatched', () => {
    expect(bayStatusCopy({ bayId: 2, occupied: false })).toBe('Clear · — confidence');
  });

  it("reads an explicit Can't confirm with the reason when the stream degrades (yp6.3)", () => {
    expect(bayStatusCopy({ bayId: 0, occupied: true }, true, 'no-data')).toBe(
      "Can't confirm · waiting for detections",
    );
    expect(bayStatusCopy({ bayId: 0, occupied: true }, true, 'feed-stale')).toBe(
      "Can't confirm · detection feed stale",
    );
    expect(bayStatusCopy({ bayId: 0, occupied: true }, true, 'feed-offline')).toBe(
      "Can't confirm · inference offline",
    );
  });

  it("reads Can't confirm for a bay never observed — no silent \"Clear\" guess", () => {
    expect(bayStatusCopy(undefined, true, null)).toBe("Can't confirm · no data yet");
  });

  it("reads Can't confirm for an occupied match below the trust threshold", () => {
    expect(bayStatusCopy({ bayId: 0, occupied: true, confidence: 0.2 })).toBe(
      "Can't confirm · weak truck match",
    );
  });
});

describe('bayTone', () => {
  it('maps occupied bays to the occupied (danger) tone', () => {
    expect(bayTone({ bayId: 1, occupied: true, confidence: 0.87 })).toBe('occupied');
  });

  it('maps any present empty-bay state to the clear (ok) tone, with or without confidence', () => {
    expect(bayTone({ bayId: 0, occupied: false, confidence: 0.98 })).toBe('clear');
    expect(bayTone({ bayId: 0, occupied: false })).toBe('clear'); // "—" copy is still live data
  });

  it('reads all cards as the unknown tone while the sim is idle', () => {
    expect(bayTone({ bayId: 0, occupied: true }, false)).toBe('unknown');
    expect(bayTone(undefined, false)).toBe('unknown');
  });

  it('maps missing state entries (stale/no data) to the unknown tone', () => {
    expect(bayTone(undefined)).toBe('unknown');
  });

  it('maps every bay to the unknown tone when the stream has a problem (yp6.3)', () => {
    expect(bayTone({ bayId: 0, occupied: true, confidence: 0.9 }, true, 'feed-stale')).toBe(
      'unknown',
    );
    expect(bayTone({ bayId: 0, occupied: false, confidence: 0.9 }, true, 'no-data')).toBe(
      'unknown',
    );
  });

  it('maps a weak occupied match to the unknown tone (trust threshold)', () => {
    expect(bayTone({ bayId: 0, occupied: true, confidence: 0.2 })).toBe('unknown');
  });
});

describe('bayDurationCopy', () => {
  const NOW = 1_700_000_400_000; // 400s after T_FIX

  it('formats the elapsed time since the state transition timestamp', () => {
    expect(bayDurationCopy({ bayId: 0, occupied: true, sinceMs: NOW - 6 * 60_000 }, NOW)).toBe(
      'for 6 min',
    );
    expect(
      bayDurationCopy({ bayId: 0, occupied: true, sinceMs: NOW - 72 * 60_000 }, NOW),
    ).toBe('for 1 h 12 m');
  });

  it('returns null while the sim is idle — no live truth to date from', () => {
    expect(
      bayDurationCopy({ bayId: 0, occupied: true, sinceMs: NOW - 60_000 }, NOW, false),
    ).toBeNull();
  });

  it('returns null when the state has no sinceMs or a non-finite one', () => {
    expect(bayDurationCopy({ bayId: 0, occupied: true, sinceMs: Number.NaN }, NOW)).toBeNull();
    expect(bayDurationCopy(undefined, NOW)).toBeNull();
  });

  it('clamps skewed clocks to "for under a min", never negative copy', () => {
    expect(bayDurationCopy({ bayId: 0, occupied: true, sinceMs: NOW + 30_000 }, NOW)).toBe(
      'for under a min',
    );
  });
});

describe('ParkingBaysPanel', () => {
  it('renders one card per bay in bays.json order, using bay ids for identity', () => {
    const store = createAppStateStore();
    store.setBayLayout(layout);
    const html = renderWithStore(store);
    expect(html).toContain('Bay 01');
    expect(html).toContain('Bay 02');
    expect(html).toContain('Bay 08'); // id 7 -> 1-based label
    expect(html.match(/card/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('shows state copy from store bayStates, matched by bay id', () => {
    const store = createAppStateStore();
    store.setBayLayout(layout);
    store.setSimRunning(true); // live copy only exists once the sim runs
    store.setDetections(FRESH_DETECTIONS); // fresh evidence (yp6.3)
    store.setBayStates([
      { bayId: 1, occupied: true, confidence: 0.87, sinceMs: Date.now() - 6.5 * 60_000 },
      { bayId: 0, occupied: false, confidence: 0.98, sinceMs: Date.now() - 6.5 * 60_000 },
    ]);
    const html = renderWithStore(store);
    expect(html).toContain('Occupied · truck detected');
    expect(html).toContain('Clear · 98% confidence');
    // "Since when" (yp6.2): recomputed from sinceMs at render time.
    expect(html).toContain('for 6 min');
  });

  it("reads Can't confirm on every card while the detection feed is stale (yp6.3)", () => {
    vi.useFakeTimers();
    try {
      const store = createAppStateStore();
      store.setBayLayout(layout);
      store.setSimRunning(true);
      store.setDetections(FRESH_DETECTIONS); // receipt stamped at mocked now
      vi.advanceTimersByTime(6_000); // past DETECTIONS_STALE_AFTER_MS (5s)
      store.setBayStates([{ bayId: 0, occupied: true, confidence: 0.9, sinceMs: T_FIX }]);
      const html = renderWithStore(store);
      expect(html).toContain('· detection feed stale'); // apostrophe is HTML-encoded
      expect(html).not.toContain('Occupied · truck detected'); // no silent last-known claim
      expect(html).not.toContain('for '); // duration rides the state claim: hidden
    } finally {
      vi.useRealTimers();
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('omits the duration on cards without a sinceMs stamp or while idle', () => {
    const store = createAppStateStore();
    store.setBayLayout(layout);
    store.setSimRunning(true);
    store.setDetections(FRESH_DETECTIONS);
    store.setBayStates([
      { bayId: 0, occupied: false, confidence: 0.9, sinceMs: Number.NaN }, // bad stamp
    ]);
    let html = renderWithStore(store);
    expect(html).not.toContain('for ');

    store.setSimRunning(false);
    store.setBayStates([{ bayId: 0, occupied: false, confidence: 0.9, sinceMs: T_FIX }]);
    html = renderWithStore(store);
    expect(html).not.toContain('for '); // idle cards read "Waiting to start" only
  });

  it("reads Can't confirm · no data yet for running bays never observed (yp6.3)", () => {
    const store = createAppStateStore();
    store.setBayLayout(layout); // no setBayStates: store holds no states yet
    store.setSimRunning(true);
    store.setDetections(FRESH_DETECTIONS);
    const html = renderWithStore(store);
    expect(html).toContain('· no data yet'); // apostrophe is HTML-encoded
    expect(html).not.toContain('Clear · — confidence'); // no silent baseline guess
  });

  it('reads Waiting to start on every card while the sim is idle', () => {
    const store = createAppStateStore();
    store.setBayLayout(layout);
    store.setBayStates([{ bayId: 1, occupied: true, confidence: 0.87, sinceMs: T_FIX }]);
    const html = renderWithStore(store); // simRunning defaults to false
    expect(html).toContain('Waiting to start');
    expect(html).not.toContain('Occupied · truck detected');
  });

  it('renders nothing when the bay layout has not loaded', () => {
    const html = renderWithStore(createAppStateStore());
    expect(html).not.toContain('Bay 01');
  });

  it('color-codes cards by occupancy state (occupied / clear / unknown tones)', () => {
    const store = createAppStateStore();
    store.setBayLayout(layout);
    store.setSimRunning(true);
    store.setDetections(FRESH_DETECTIONS);
    store.setBayStates([
      { bayId: 0, occupied: true, confidence: 0.9, sinceMs: T_FIX }, // occupied
      { bayId: 1, occupied: false, confidence: 0.95, sinceMs: T_FIX }, // clear
      // id 7 absent -> unknown fallback
    ]);
    const html = renderWithStore(store);
    const cardClasses = [...html.matchAll(/class="([^"]*card[^"]*)"/g)].map((m) => m[1]);
    expect(cardClasses.some((c) => /bayCardOccupied/.test(c))).toBe(true);
    expect(cardClasses.some((c) => /bayCardClear/.test(c))).toBe(true);
    expect(cardClasses.some((c) => /bayCardUnknown/.test(c))).toBe(true);
  });
});