/**
 * InferenceStatus tests (bead: move inference health to the top bar). Covers
 * the pure health mapping across all three states plus render checks via
 * react-dom/server. The component renders as a header Pill sharing the
 * live-feed pill styling; the former sidebar card is retired.
 */

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAppStateStore, type AppStateStore, type HudStats } from '../state/store';
import { AppStateProvider } from '../state/react';
import { formatStats, inferenceHealth, InferenceStatus, toneForHealth } from './InferenceStatus';

const healthyHud: HudStats = { frameId: 42, latencyMs: 84, inferenceMs: 71, captureFps: 11 };
const degradedHud: HudStats = { frameId: 42, latencyMs: 350, inferenceMs: 300, captureFps: 4 };
const noDataHud: HudStats = { frameId: null, latencyMs: null, inferenceMs: null, captureFps: 0 };

function renderWithStore(store: AppStateStore): string {
  return renderToStaticMarkup(
    // AppStateProvider requires children in its props object (createElement).
    createElement(AppStateProvider, {
      store,
      children: createElement(InferenceStatus),
    }),
  );
}

describe('inferenceHealth', () => {
  it('is healthy when online with a recent low-latency result', () => {
    expect(inferenceHealth('online', healthyHud)).toBe('healthy');
    expect(inferenceHealth('connecting', healthyHud)).toBe('healthy');
  });

  it('is degraded before the first result or above the latency threshold', () => {
    expect(inferenceHealth('online', noDataHud)).toBe('degraded');
    expect(inferenceHealth('online', degradedHud)).toBe('degraded');
  });

  it('is offline whenever the connection status is offline', () => {
    expect(inferenceHealth('offline', healthyHud)).toBe('offline');
    expect(inferenceHealth('offline', noDataHud)).toBe('offline');
  });
});

describe('formatStats', () => {
  it('formats fps and latency with a dash before the first result', () => {
    expect(formatStats(healthyHud)).toBe('11 fps · 84.0 ms');
    expect(formatStats(noDataHud)).toBe('0 fps · —');
  });
});

describe('toneForHealth', () => {
  it('maps healthy to ok, offline to danger, degraded to neutral', () => {
    expect(toneForHealth('healthy')).toBe('ok');
    expect(toneForHealth('offline')).toBe('danger');
    expect(toneForHealth('degraded')).toBe('neutral');
  });
});

describe('InferenceStatus', () => {
  it('renders the healthy label with fps and latency stats', () => {
    const store = createAppStateStore();
    store.setConnectionStatus('online');
    store.setHud(healthyHud);
    const html = renderWithStore(store);
    expect(html).toContain('Inference healthy');
    expect(html).toContain('11 fps');
    expect(html).toContain('84.0 ms');
  });

  it('renders the degraded state while there is no data yet', () => {
    const html = renderWithStore(createAppStateStore()); // defaults: connecting, no data
    expect(html).toContain('Inference degraded');
    expect(html).toContain('0 fps');
    expect(html).toContain('—');
    const pillClass = html.match(/class="([^"]*)"[^>]*role="status"/) ?? ['', ''];
    expect(pillClass[1]).toContain('neutral');
  });

  it('renders the offline state when the store reports offline', () => {
    const store = createAppStateStore();
    store.setConnectionStatus('offline');
    const html = renderWithStore(store);
    expect(html).toContain('Inference offline');
    const pillClass = html.match(/class="([^"]*)"[^>]*role="status"/) ?? ['', ''];
    expect(pillClass[1]).toContain('danger');
  });
});
