/**
 * Resolves the detection-service WebSocket URL.
 *
 * Priority: explicit VITE_DETECT_WS_URL build-time override, otherwise
 * same-origin derivation (`ws(s)://<location.host>/ws/detect`). The same-origin
 * default is what makes single-container deployments (e.g. Fly.io, where
 * FastAPI serves the frontend build and the WebSocket from one origin) work
 * with no per-environment configuration: Fly terminates TLS, so an
 * `https:` page talks to `wss:` on the same host.
 */

const DETECT_WS_PATH = '/ws/detect';

/** Builds a same-origin detection WS URL from a page location. */
export function sameOriginDetectWsUrl(loc: Pick<Location, 'protocol' | 'host'>): string {
  const scheme = loc.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${loc.host}${DETECT_WS_PATH}`;
}

/**
 * Picks the WS URL for the detect client: the Vite env override when set
 * (e.g. dev against a local backend on :8000), else same-origin derivation.
 */
export function resolveDetectWsUrl(
  envUrl: unknown,
  loc: Pick<Location, 'protocol' | 'host'>,
): string {
  if (typeof envUrl === 'string' && envUrl.length > 0) return envUrl;
  return sameOriginDetectWsUrl(loc);
}
