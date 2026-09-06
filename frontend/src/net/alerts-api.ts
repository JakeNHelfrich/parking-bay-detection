/**
 * Alerts REST client (bead rzo.5) — the in-app delivery channel.
 *
 * Alerts live in the server's durable record and are surfaced read-only over
 * `GET /api/alerts` (plus `POST /api/alerts/{id}/ack` to dismiss). This module
 * is plain fetch glue: types, URL resolution, and request wrappers. UI state
 * flows through the store; nothing here holds app state.
 *
 * Base-URL resolution mirrors `ws-url.ts`: an explicit `VITE_ALERTS_API_URL`
 * build-time override (e.g. dev against a local backend on :8000), else
 * same-origin — which is what makes single-container deployments work with
 * no per-environment configuration.
 */

/** One alert as served by `GET /api/alerts` (camelCase wire contract). */
export interface AlertSummary {
  readonly id: number;
  readonly bayId: number;
  /** Which rule fired: 'overstay' | 'afterHours' (open set — new rules may come). */
  readonly rule: string;
  /** Opening time of the episode that triggered the alert (ISO 8601 UTC). */
  readonly since: string;
  /** Server clock when the alert was raised (ISO 8601 UTC). */
  readonly raisedAt: string;
  readonly acknowledged: boolean;
  /** Rule-specific detail (dwellMinutes/elapsedMinutes, activeHours, …). */
  readonly detail: Readonly<Record<string, unknown>>;
}

const ALERTS_PATH = '/api/alerts';

/** Builds a same-origin alerts API base from a page location. */
export function sameOriginAlertsApiBase(loc: Pick<Location, 'protocol' | 'host'>): string {
  return `${loc.protocol}//${loc.host}${ALERTS_PATH}`;
}

/** Picks the alerts API base: env override when set, else same-origin. */
export function resolveAlertsApiBase(
  envUrl: unknown,
  loc: Pick<Location, 'protocol' | 'host'>,
): string {
  if (typeof envUrl === 'string' && envUrl.length > 0) return envUrl;
  return sameOriginAlertsApiBase(loc);
}

/** Narrowing guard for one alert record from the wire. */
export function isAlertSummary(value: unknown): value is AlertSummary {
  if (typeof value !== 'object' || value === null) return false;
  const alert = value as Record<string, unknown>;
  return (
    typeof alert.id === 'number' &&
    typeof alert.bayId === 'number' &&
    typeof alert.rule === 'string' &&
    typeof alert.since === 'string' &&
    typeof alert.raisedAt === 'string' &&
    typeof alert.acknowledged === 'boolean' &&
    typeof alert.detail === 'object' &&
    alert.detail !== null
  );
}

/** Narrowing guard for the `GET /api/alerts` payload. */
export function isAlertsResponse(value: unknown): value is { alerts: AlertSummary[] } {
  if (typeof value !== 'object' || value === null) return false;
  const alerts = (value as Record<string, unknown>).alerts;
  return Array.isArray(alerts) && alerts.every(isAlertSummary);
}

export interface AlertsClient {
  /** Unacknowledged alerts, newest first. Throws on non-2xx/invalid payload. */
  fetchUnacknowledged(): Promise<AlertSummary[]>;
  /** Acknowledges one alert. Throws on non-2xx. */
  acknowledge(id: number): Promise<void>;
}

export function createAlertsClient(baseUrl: string, fetchImpl: typeof fetch = fetch): AlertsClient {
  return {
    async fetchUnacknowledged(): Promise<AlertSummary[]> {
      const response = await fetchImpl(`${baseUrl}?unacknowledged=true`, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`alerts fetch failed: ${response.status}`);
      const payload: unknown = await response.json();
      if (!isAlertsResponse(payload)) throw new Error('alerts payload failed validation');
      return payload.alerts;
    },

    async acknowledge(id: number): Promise<void> {
      const response = await fetchImpl(`${baseUrl}/${id}/ack`, { method: 'POST' });
      if (!response.ok) throw new Error(`alert ack failed: ${response.status}`);
    },
  };
}
