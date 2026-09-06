/**
 * History REST client (bead rzo.4) — the frontend face of `/api/history`.
 *
 * The server aggregates occupancy episodes from its durable record (rzo.2/3);
 * this module is plain fetch glue: wire types, narrowing guards, URL
 * resolution, and request wrappers. The history view fetches on demand (view
 * open / shift change) — no polling, no app state of its own.
 *
 * Base-URL resolution mirrors `alerts-api.ts`: an explicit
 * `VITE_HISTORY_API_URL` build-time override, else same-origin — which is
 * what makes single-container deployments work with no per-environment
 * configuration.
 */

/** One occupancy episode as served by `GET /api/history/timeline/{bayId}`. */
export interface HistoryInterval {
  readonly id: number;
  readonly bayId: number;
  /** Bay-map content hash the episode was recorded under (provenance). */
  readonly mapVersion: string;
  /** Episode opening time (ISO 8601 UTC). */
  readonly since: string;
  /** Episode closing time, or null while still open. */
  readonly until: string | null;
  readonly open: boolean;
  /** Occupied seconds — clipped to the queried window by the server. */
  readonly durationSeconds: number;
  readonly confidence: number | null;
  readonly openFrameId: number;
  readonly closeFrameId: number | null;
}

export interface BayTimelineResponse {
  readonly bayId: number;
  readonly from: string;
  readonly to: string;
  readonly intervals: readonly HistoryInterval[];
}

/** The episode still open at query time, if any. */
export interface OpenEpisode {
  readonly since: string;
  readonly durationSeconds: number;
  readonly mapVersion: string;
  readonly confidence: number | null;
}

/** Per-bay dwell statistics over a window (episodes clipped to it). */
export interface BayDwellSummary {
  readonly bayId: number;
  readonly episodes: number;
  readonly totalSeconds: number;
  readonly meanSeconds: number;
  readonly maxSeconds: number;
  readonly open: OpenEpisode | null;
}

export interface DwellResponse {
  readonly from: string;
  readonly to: string;
  readonly bays: readonly BayDwellSummary[];
}

const HISTORY_PATH = '/api/history';

/** Builds a same-origin history API base from a page location. */
export function sameOriginHistoryApiBase(loc: Pick<Location, 'protocol' | 'host'>): string {
  return `${loc.protocol}//${loc.host}${HISTORY_PATH}`;
}

/** Picks the history API base: env override when set, else same-origin. */
export function resolveHistoryApiBase(
  envUrl: unknown,
  loc: Pick<Location, 'protocol' | 'host'>,
): string {
  if (typeof envUrl === 'string' && envUrl.length > 0) return envUrl;
  return sameOriginHistoryApiBase(loc);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === 'number';
}

/** Narrowing guard for one occupancy episode from the wire. */
export function isHistoryInterval(value: unknown): value is HistoryInterval {
  if (typeof value !== 'object' || value === null) return false;
  const interval = value as Record<string, unknown>;
  return (
    typeof interval.id === 'number' &&
    typeof interval.bayId === 'number' &&
    typeof interval.mapVersion === 'string' &&
    typeof interval.since === 'string' &&
    (interval.until === null || typeof interval.until === 'string') &&
    typeof interval.open === 'boolean' &&
    typeof interval.durationSeconds === 'number' &&
    isNullableNumber(interval.confidence) &&
    typeof interval.openFrameId === 'number' &&
    isNullableNumber(interval.closeFrameId)
  );
}

/** Narrowing guard for the `GET /api/history/timeline/{bayId}` payload. */
export function isBayTimelineResponse(value: unknown): value is BayTimelineResponse {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  return (
    typeof payload.bayId === 'number' &&
    typeof payload.from === 'string' &&
    typeof payload.to === 'string' &&
    Array.isArray(payload.intervals) &&
    payload.intervals.every(isHistoryInterval)
  );
}

/** Narrowing guard for one open-episode record. */
export function isOpenEpisode(value: unknown): value is OpenEpisode {
  if (typeof value !== 'object' || value === null) return false;
  const episode = value as Record<string, unknown>;
  return (
    typeof episode.since === 'string' &&
    typeof episode.durationSeconds === 'number' &&
    typeof episode.mapVersion === 'string' &&
    isNullableNumber(episode.confidence)
  );
}

/** Narrowing guard for one per-bay dwell summary. */
export function isBayDwellSummary(value: unknown): value is BayDwellSummary {
  if (typeof value !== 'object' || value === null) return false;
  const summary = value as Record<string, unknown>;
  return (
    typeof summary.bayId === 'number' &&
    typeof summary.episodes === 'number' &&
    typeof summary.totalSeconds === 'number' &&
    typeof summary.meanSeconds === 'number' &&
    typeof summary.maxSeconds === 'number' &&
    (summary.open === null || isOpenEpisode(summary.open))
  );
}

/** Narrowing guard for the `GET /api/history/dwell` payload. */
export function isDwellResponse(value: unknown): value is DwellResponse {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  return (
    typeof payload.from === 'string' &&
    typeof payload.to === 'string' &&
    Array.isArray(payload.bays) &&
    payload.bays.every(isBayDwellSummary)
  );
}

export interface HistoryClient {
  /** One bay's occupancy episodes over `[from, to)`. Throws on non-2xx/invalid. */
  fetchTimeline(bayId: number, fromIso: string, toIso: string): Promise<BayTimelineResponse>;
  /** Per-bay dwell summaries over `[from, to)`. Throws on non-2xx/invalid. */
  fetchDwell(fromIso: string, toIso: string): Promise<DwellResponse>;
}

/**
 * `URLSearchParams` is the query encoder precisely because ISO timestamps
 * carry a `+` offset: the form-urlencoded serializer escapes it (`%2B`),
 * where naive string interpolation would deliver a space and trip the
 * server's 422 (see README: URL-encoding hint).
 */
function windowQuery(fromIso: string, toIso: string): string {
  return new URLSearchParams({ from: fromIso, to: toIso }).toString();
}

export function createHistoryClient(baseUrl: string, fetchImpl: typeof fetch = fetch): HistoryClient {
  return {
    async fetchTimeline(bayId, fromIso, toIso): Promise<BayTimelineResponse> {
      const response = await fetchImpl(
        `${baseUrl}/timeline/${bayId}?${windowQuery(fromIso, toIso)}`,
        { headers: { Accept: 'application/json' } },
      );
      if (!response.ok) throw new Error(`history fetch failed: ${response.status}`);
      const payload: unknown = await response.json();
      if (!isBayTimelineResponse(payload)) throw new Error('history payload failed validation');
      return payload;
    },

    async fetchDwell(fromIso, toIso): Promise<DwellResponse> {
      const response = await fetchImpl(`${baseUrl}/dwell?${windowQuery(fromIso, toIso)}`, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`history fetch failed: ${response.status}`);
      const payload: unknown = await response.json();
      if (!isDwellResponse(payload)) throw new Error('history payload failed validation');
      return payload;
    },
  };
}
