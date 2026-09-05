/**
 * InferenceHealthCard — the sidebar "Inference healthy" banner per
 * design/desktop.png: pulse icon + health label + fps/latency stats.
 *
 * App-level component consuming the store (connection status + HUD stats).
 * Health mapping is pure and exported for tests:
 * - `offline`  — connection is offline (connection status is authoritative)
 * - `degraded` — no inference results yet, or latency above
 *                INFERENCE_HEALTHY_MAX_MS
 * - `healthy`  — online with a recent low-latency result
 */

import { useAppState } from '../state/react';
import type { ConnectionStatus } from '../net/detect-client';
import type { HudStats } from '../state/store';
import { INFERENCE_HEALTHY_MAX_MS } from '../config';
import { Card, PulseIcon } from './components';
import styles from './InferenceHealthCard.module.css';

export type InferenceHealth = 'healthy' | 'degraded' | 'offline';

export function inferenceHealth(
  status: ConnectionStatus,
  hud: HudStats,
): InferenceHealth {
  if (status === 'offline') return 'offline';
  if (hud.latencyMs === null || hud.latencyMs > INFERENCE_HEALTHY_MAX_MS) {
    return 'degraded';
  }
  return 'healthy';
}

const HEALTH_LABEL: Record<InferenceHealth, string> = {
  healthy: 'Inference healthy',
  degraded: 'Inference degraded',
  offline: 'Inference offline',
};

/** "11 fps · 84.2 ms" — dash placeholders before the first result. */
function formatStats(hud: HudStats): string {
  const fps = `${hud.captureFps.toFixed(0)} fps`;
  const latency = hud.latencyMs === null ? '—' : `${hud.latencyMs.toFixed(1)} ms`;
  return `${fps} · ${latency}`;
}

export function InferenceHealthCard() {
  const status = useAppState((state) => state.connectionStatus);
  const hud = useAppState((state) => state.hud);
  const health = inferenceHealth(status, hud);

  return (
    <Card
      className={[styles.card, styles[health]].filter(Boolean).join(' ')}
      role="status"
    >
      <h3 className={styles.head}>
        <PulseIcon size={14} />
        {HEALTH_LABEL[health]}
      </h3>
      <p className={styles.stats}>{formatStats(hud)}</p>
    </Card>
  );
}