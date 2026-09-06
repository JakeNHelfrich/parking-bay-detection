/**
 * ParkingBaysPanel — sidebar bay list per design/desktop.png.
 *
 * Read-only over the store's bay data: the bay list comes from
 * `bayLayout.bays` (parsed from the runtime-fetched `bays.json`), per-bay
 * state copy from `bayStates`, so editing `bays.json` changes the panel
 * with no code change (invariant 4). Bay identity comes only from bay ids
 * (invariant 5) — nothing here derives identity from model output.
 *
 * Pure helpers are exported for tests: `bayLabel` (bayId -> "Bay 01"),
 * `bayStatusCopy` (BayState -> state copy per the mockup copywriting) and
 * `bayDurationCopy` (StableBayState + now -> "for 6 min" or null).
 */

import { useAppState } from '../state/react';
import type { BayState } from '../bays/occupancy';
import type { StableBayState } from '../bays/stabilizer';
import { trustIssue, bayIsUnconfirmed, BAY_TRUST_MIN_CONFIDENCE, type TrustIssue } from '../bays/trust';
import { durationSince } from './duration';
import { Card } from './components';
import styles from './ParkingBaysPanel.module.css';

const toneStyles = {
  occupied: styles.bayCardOccupied,
  clear: styles.bayCardClear,
  unknown: styles.bayCardUnknown,
} as const;

/** Pure label formatter: bayId 0 -> "Bay 01" (1-based, zero-padded). */
export function bayLabel(bayId: number): string {
  return `Bay ${String(bayId + 1).padStart(2, '0')}`;
}

/** Pure copy formatter per the mockup: state + occupancy-confidence bead.
 *  While the sim is idle there is no detection stream yet, so every bay
 *  reads "Waiting to start" (bead parking-bay-detection-tdq). When the
 *  evidence stream cannot support a claim (yp6.3), every bay reads an
 *  explicit "Can't confirm" with the reason — never a silent last-known
 *  state, and a never-observed bay says so instead of guessing "Clear". */
export function bayStatusCopy(
  state: BayState | undefined,
  simRunning = true,
  issue: TrustIssue | null = null,
): string {
  if (!simRunning || issue === 'idle') return 'Waiting to start';
  if (issue === 'no-data') return "Can't confirm · waiting for detections";
  if (issue === 'feed-stale') return "Can't confirm · detection feed stale";
  if (issue === 'feed-offline') return "Can't confirm · inference offline";
  if (state === undefined) return "Can't confirm · no data yet";
  if (state.occupied) {
    if (state.confidence !== undefined && state.confidence < BAY_TRUST_MIN_CONFIDENCE) {
      return "Can't confirm · weak truck match";
    }
    return 'Occupied · truck detected';
  }
  const pct =
    state.confidence === undefined ? '—' : `${Math.round(state.confidence * 100)}%`;
  return `Clear · ${pct} confidence`;
}

/** Bay-card accent tone: gray ("unknown") whenever the bay's state may not
 *  be asserted — sim idle, evidence stream degraded, no observation, or a
 *  weak match; otherwise red FULL / green EMPTY mirroring the overlay. */
export function bayTone(
  state: BayState | undefined,
  simRunning = true,
  issue: TrustIssue | null = null,
): BayTone {
  if (!simRunning || bayIsUnconfirmed(state, issue)) return 'unknown';
  return state!.occupied ? 'occupied' : 'clear';
}

export type BayTone = 'occupied' | 'clear' | 'unknown';

/**
 * Per-bay "since when" copy (bead yp6.2): "for 6 min" while the sim runs and
 * the stabilized state carries a transition timestamp, null otherwise (no
 * state yet, no `sinceMs`, or idle — idle cards read "Waiting to start" and
 * have no live truth to date from). Callers pass `now` explicitly; the
 * component takes it at render time, so the duration is recomputed from the
 * store snapshot on each store emit (~10/s while running) with no
 * per-component timers. The future board view (yp6.4) reuses this rule.
 */
export function bayDurationCopy(
  state: StableBayState | undefined,
  nowMs: number,
  simRunning = true,
): string | null {
  if (!simRunning || state?.sinceMs === undefined || !Number.isFinite(state.sinceMs)) {
    return null;
  }
  return `for ${durationSince(state.sinceMs, nowMs)}`;
}

export function ParkingBaysPanel() {
  const bayLayout = useAppState((state) => state.bayLayout);
  const bayStates = useAppState((state) => state.bayStates);
  const simRunning = useAppState((state) => state.simRunning);

  const connectionStatus = useAppState((state) => state.connectionStatus);
  const detectionsAtMs = useAppState((state) => state.detectionsAtMs);

  const bays = bayLayout?.bays ?? [];
  // Index BayStates by bay id: the store may hold states computed against a
  // previous layout, so never zip bays and states positionally.
  const stateById = new Map(bayStates.map((state) => [state.bayId, state]));

  // `now` is taken at render, not from a timer: the store re-emits on every
  // detections frame (~10/s while running), so each emit recomputes the
  // durations and the trust verdict (yp6.3) from the snapshot; the rAF-driven
  // HUD heartbeat keeps staleness fresh between detection frames.
  const nowMs = Date.now();
  const issue = trustIssue({ simRunning, connectionStatus, detectionsAtMs, nowMs });

  return (
    <div className={styles.list}>
      {bays.map((bay) => {
        const state = stateById.get(bay.id);
        const tone = bayTone(state, simRunning, issue);
        // Duration rides the state claim: hidden whenever the bay is
        // unconfirmed — "for 6 min" under "Can't confirm" would dress the
        // last-known state up as current truth.
        const duration = bayIsUnconfirmed(state, issue)
          ? null
          : bayDurationCopy(state, nowMs, simRunning);
        return (
          <Card
            key={bay.id}
            className={[styles.bayCard, toneStyles[tone]].filter(Boolean).join(' ')}
          >
            <h3 className={styles.bayTitle}>{bayLabel(bay.id)}</h3>
            <p className={styles.bayStatus}>{bayStatusCopy(state, simRunning, issue)}</p>
            {duration === null ? null : <p className={styles.baySince}>{duration}</p>}
          </Card>
        );
      })}
    </div>
  );
}