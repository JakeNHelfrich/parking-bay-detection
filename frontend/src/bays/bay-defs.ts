/**
 * Parking-bay geometry — data, not code.
 *
 * Bay rectangles live in `public/bays.json` as normalized `[x, y, w, h]`
 * rects (0..1, origin TOP-LEFT — the same convention as wire bboxes) and
 * are fetched at runtime, so the bay layout can be edited without a
 * rebuild. They are screen-space projections of the world-space bay slots
 * in `src/scene/layout.ts` for the default camera at a 16:9 view.
 *
 * Pure parsing/validation lives here; the fetch wrapper is the only part
 * that touches the network.
 */

export type BaySide = 'north' | 'south';

export interface BayDef {
  readonly id: number;
  readonly side: BaySide;
  /** Normalized [x, y, w, h], 0..1, origin top-left. */
  readonly rect: readonly [number, number, number, number];
}

export interface BayLayout {
  readonly version: number;
  readonly bays: readonly BayDef[];
}

function isNormalizedRect(value: unknown): value is [number, number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)
  );
}

/**
 * Parses and validates a parsed-JSON value into a BayLayout.
 * Returns null on any shape error (bad version, duplicate/invalid ids,
 * out-of-range rects); callers must treat null as "no bay overlay".
 */
export function parseBayLayout(raw: unknown): BayLayout | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) return null;
  if (!Array.isArray(obj.bays) || obj.bays.length === 0) return null;
  const seenIds = new Set<number>();
  const bays: BayDef[] = [];
  for (const item of obj.bays) {
    if (typeof item !== 'object' || item === null) return null;
    const b = item as Record<string, unknown>;
    const { id, side, rect } = b;
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || seenIds.has(id)) return null;
    if (side !== 'north' && side !== 'south') return null;
    if (!isNormalizedRect(rect)) return null;
    seenIds.add(id);
    bays.push({ id, side, rect });
  }
  return { version: 1, bays };
}

/**
 * Fetches and parses `bays.json` (served from `public/`, unbundled).
 * Resolves null on fetch/parse failure so the sim keeps running without
 * bay occupancy instead of crashing startup.
 */
export async function loadBayLayout(url = 'bays.json'): Promise<BayLayout | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return parseBayLayout(await response.json());
  } catch {
    return null;
  }
}
