/**
 * Stale-frame policy: a detection result is stale when it is not NEWER than
 * the latest result already shown by the overlay.
 *
 * Comparing against the latest *shown* result (not the latest *captured*
 * frame) is deliberate: capture IDs advance every ~90 ms regardless of
 * inference, so when latency approaches the capture interval, replies would
 * perpetually trail the capture counter and be dropped — the overlay would
 * show nothing at all. What the overlay needs is "never regress": accept a
 * result only if its frameId is strictly newer than the one displayed.
 * (Server replies are in-order — superseded frames are skipped server-side —
 * so in practice this only filters duplicates.)
 */
export function isStaleFrame(resultFrameId: number, latestShownFrameId: number): boolean {
  return resultFrameId <= latestShownFrameId;
}
