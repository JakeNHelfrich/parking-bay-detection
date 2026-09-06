/**
 * ParkingBaysPanel tests (bead: parking bays sidebar panel). Covers the
 * pure label formatter (AC) and the store-driven render: bay list derives
 * from bays.json data in the store, state copy from bayStates.
 */

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAppStateStore, type AppStateStore } from '../state/store';
import { AppStateProvider } from '../state/react';
import type { BayLayout } from '../bays/bay-defs';
import { bayLabel, bayStatusCopy, bayTone, ParkingBaysPanel } from './ParkingBaysPanel';

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
    store.setBayStates([
      { bayId: 1, occupied: true, confidence: 0.87 },
      { bayId: 0, occupied: false, confidence: 0.98 },
    ]);
    const html = renderWithStore(store);
    expect(html).toContain('Occupied · truck detected');
    expect(html).toContain('Clear · 98% confidence');
  });

  it('falls back to an unmatched (clear, no-confidence) state for unmapped bays', () => {
    const store = createAppStateStore();
    store.setBayLayout(layout); // no setBayStates: store holds no states yet
    store.setSimRunning(true);
    const html = renderWithStore(store);
    expect(html).toContain('Clear · — confidence');
  });

  it('reads Waiting to start on every card while the sim is idle', () => {
    const store = createAppStateStore();
    store.setBayLayout(layout);
    store.setBayStates([{ bayId: 1, occupied: true, confidence: 0.87 }]);
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
    store.setBayStates([
      { bayId: 0, occupied: true, confidence: 0.9 }, // occupied
      { bayId: 1, occupied: false, confidence: 0.95 }, // clear
      // id 7 absent -> unknown fallback
    ]);
    const html = renderWithStore(store);
    const cardClasses = [...html.matchAll(/class="([^"]*card[^"]*)"/g)].map((m) => m[1]);
    expect(cardClasses.some((c) => /bayCardOccupied/.test(c))).toBe(true);
    expect(cardClasses.some((c) => /bayCardClear/.test(c))).toBe(true);
    expect(cardClasses.some((c) => /bayCardUnknown/.test(c))).toBe(true);
  });
});