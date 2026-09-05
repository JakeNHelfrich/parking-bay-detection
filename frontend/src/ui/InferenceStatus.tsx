/**
 * InferenceStatus — the header inference-health pill (bead: move inference
 * health to the top bar). Sits in the header's meta row next to the
 * live-feed pill so both health signals read as one status cluster; it
 * replaces the former sidebar "Inference healthy" card.
 *
 * App-level component consuming the store (connection status + HUD stats).
 * Health mapping is pure and exported for tests:
 * - `offline`  — connection is offline (connection status is authoritative)
 * - `degraded` — no inference results yet, or latency above
 *                INFERENCE_HEALTHY_MAX_MS
 * - `healthy`  — online with a recent low-latency result
 *
 * Rendered with the shared Pill primitive (same styling as the live-feed
 * pill): healthy -> ok green, offline -> danger red, degraded -> neutral
 * gray (muted, per the tokens — there is no warning color).
 */

import { useAppState } from '../state/react';
import type { ConnectionStatus } from '../net/detect-client';
import type { HudStats } from '../state/store';
import { INFERENCE_HEALTHY_MAX_MS } from '../config';
import { Pill } from './components';
import type { PillProps } from './components';

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
export function formatStats(hud: HudStats): string {
  const fps = `${hud.captureFps.toFixed(0)} fps`;
  const latency = hud.latencyMs === null ? '—' : `${hud.latencyMs.toFixed(1)} ms`;
  return `${fps} · ${latency}`;
}

/** Health -> Pill tone: green healthy, red offline, muted gray degraded. */
export function toneForHealth(health: InferenceHealth): PillProps['tone'] {
  if (health === 'healthy') return 'ok';
  return health === 'offline' ? 'danger' : 'neutral';
}

export function InferenceStatus() {
  const status = useAppState((state) => state.connectionStatus);
  const hud = useAppState((state) => state.hud);
  const health = inferenceHealth(status, hud);

  return (
    <Pill tone={toneForHealth(health)} ariaLabel={HEALTH_LABEL[health]}>
      {`${HEALTH_LABEL[health]} · ${formatStats(hud)}`}
    </Pill>
  );
}
