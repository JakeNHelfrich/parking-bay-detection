/**
 * App shell tests (bead parking-bay-detection-tdq): the idle viewport is a
 * full-surface start CTA (video-player pattern), gone once the sim runs, and
 * bay cards read "Waiting to start" while idle. Rendered via
 * react-dom/server against a real store — no DOM environment needed
 * (mountSim runs in an effect, which static markup never triggers).
 */

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAppStateStore, type AppStateStore } from './state/store';
import { App } from './App';

function markup(simRunning: boolean): string {
  const store: AppStateStore = createAppStateStore();
  store.setSimRunning(simRunning);
  return renderToStaticMarkup(createElement(App, { store }));
}

describe('idle-viewport start CTA', () => {
  it('renders a full-surface Start simulation button while idle', () => {
    const html = markup(false);
    expect(html).toContain('aria-label="Start simulation"');
    expect(html).toContain('>Start simulation</h1>');
    expect(html).toContain('watch bay occupancy');
  });

  it('removes the CTA once the sim is running', () => {
    const html = markup(true);
    expect(html).not.toContain('aria-label="Start simulation"');
  });
});

describe('bay cards while idle', () => {
  it('reads Waiting to start on every card until the sim runs', () => {
    // No bays.json in this store → no cards; the copy contract itself is
    // covered by ParkingBaysPanel tests. Here: with bays loaded, idle cards
    // show the waiting copy.
    const store = createAppStateStore();
    store.setBayLayout({
      version: 1,
      bays: [{ id: 0, side: 'north', rect: [0.1, 0.1, 0.2, 0.2] }],
    });
    const idle = renderToStaticMarkup(createElement(App, { store }));
    expect(idle).toContain('Waiting to start');

    store.setSimRunning(true);
    const running = renderToStaticMarkup(createElement(App, { store }));
    expect(running).not.toContain('Waiting to start');
  });
});
