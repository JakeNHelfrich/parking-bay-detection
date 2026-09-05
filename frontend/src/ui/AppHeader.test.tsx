/**
 * AppHeader tests (bead: header UI). Rendered via react-dom/server against a
 * real store instance — no DOM environment needed.
 *
 * Covers the acceptance criterion "all ConnectionStatus values map to a
 * designed pill state" plus the start/stop control label, camera chip, and
 * keyboard-accessible native button elements.
 */

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppStateProvider } from '../state/react';
import { createAppStateStore, type AppStateStore } from '../state/store';
import { AppHeader, pillForStatus } from './AppHeader';

function renderWithStore(store: AppStateStore): string {
  return renderToStaticMarkup(
    // AppStateProvider requires children in its props object (createElement).
    createElement(AppStateProvider, {
      store,
      children: createElement(AppHeader),
    }),
  );
}

describe('pillForStatus', () => {
  it('maps connecting and online to the green connected pill', () => {
    expect(pillForStatus('connecting')).toEqual({
      tone: 'ok',
      label: 'Live feed connected',
    });
    expect(pillForStatus('online')).toEqual({
      tone: 'ok',
      label: 'Live feed connected',
    });
  });

  it('maps offline to the red offline pill', () => {
    expect(pillForStatus('offline')).toEqual({
      tone: 'danger',
      label: 'Live feed offline',
    });
  });
});

describe('AppHeader', () => {
  it('renders brand, camera chip, pill, and start control', () => {
    const html = renderWithStore(createAppStateStore());
    expect(html).toContain('BAYWATCH');
    expect(html).toContain('CAM-04');
    expect(html).toContain('Live feed connected'); // default status: connecting
    expect(html).toContain('Start simulation');
    // Native interactive elements only (keyboard accessibility).
    expect(html).toContain('<button');
  });

  it('renders the offline pill when the store reports offline', () => {
    const store = createAppStateStore();
    store.setConnectionStatus('offline');
    const html = renderWithStore(store);
    expect(html).toContain('Live feed offline');
    const pillClass = html.match(/class="([^"]*)"[^>]*role="status"/) ?? ['', ''];
    expect(pillClass[1]).toContain('danger');
  });

  it('flips the start control to Stop when the sim is running', () => {
    const store = createAppStateStore();
    expect(renderWithStore(store)).toContain('Start simulation');
    store.setSimRunning(true);
    expect(renderWithStore(store)).toContain('Stop simulation');
  });
});