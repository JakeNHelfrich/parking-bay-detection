/**
 * Stale-frame policy: a detection result is stale when its `frameId` is
 * OLDER than the latest captured frame. Stale results are dropped, never
 * queued — the overlay always shows the most recent available result.
 */
export function isStaleFrame(resultFrameId: number, latestFrameId: number): boolean {
  return resultFrameId < latestFrameId;
}
