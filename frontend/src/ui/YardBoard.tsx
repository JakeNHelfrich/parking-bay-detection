/**
 * YardBoard — the glanceable full-viewport board (yp6.4): one large color
 * block per bay — state word + duration, minimal text — readable from across
 * a room in under 5 seconds. The sidebar cards (ParkingBaysPanel) remain the
 * detail view; this is the at-a-distance summary. Rendered as an overlay
 * above the running live view, so the sim pipeline stays mounted and the
 * board's data keeps flowing (one-way, from the immutable store snapshot).
 *
 * The overlay canvas keeps drawing only detection boxes and bay rects
 * (AGENTS: the React UI is the HUD) — no status text moves onto canvas.
 *
 * Pure helpers are exported for tests: `yardTileCopy` maps a bay's state +
 * trust verdict to the tile's tone/headline/sub copy, reusing the exact tone
 * and copy rules of the detail cards (`bayTone`, `bayStatusCopy`) so the two
 * views can never disagree.
 */

import { useAppState, useAppStateStore } from '../state/react';
import type { StableBayState } from '../bays/stabilizer';
import { trustIssue, bayIsUnconfirmed, type TrustIssue } from '../bays/trust';
import {
  bayDurationCopy,
  bayStatusCopy,
  bayTone,
  bayLabel,
  type BayTone,
} from './ParkingBaysPanel';
import styles from './YardBoard.module.css';

/** What one board tile says: tone drives the color block, headline is the
 *  across-the-room word, sub is the single supporting line (or null). */
export interface YardTileCopy {
  readonly tone: BayTone;
  readonly headline: string;
  readonly sub: string | null;
}

/**
 * Pure tile model for one bay, from the same inputs the detail cards use.
 * While the evidence stream cannot back a claim the tile reads "Can't
 * confirm" (or "Waiting" before the sim starts) with the reason — never a
 * silent last-known state (the yp6.3 rule carries over). Occupied/clear
 * tiles lead with the state word and show the state duration when it exists.
 */
export function yardTileCopy(
  state: StableBayState | undefined,
  nowMs: number,
  simRunning = true,
  issue: TrustIssue | null = null,
): YardTileCopy {
  const tone = bayTone(state, simRunning, issue);
  if (tone === 'unknown') {
    if (!simRunning || issue === 'idle') {
      return { tone, headline: 'Waiting', sub: 'start the simulation' };
    }
    // Reuse the card copy verbatim, split at the separator:
    // "Can't confirm · <reason>" -> headline + reason.
    const reason = bayStatusCopy(state, simRunning, issue).split('·')[1]?.trim() ?? null;
    return { tone, headline: "Can't confirm", sub: reason };
  }
  // Duration rides the state claim: never dress a weak match up as current.
  const duration = bayIsUnconfirmed(state, issue)
    ? null
    : bayDurationCopy(state, nowMs, simRunning);
  if (state!.occupied) {
    return { tone, headline: 'Full', sub: duration ?? 'truck detected' };
  }
  return { tone, headline: 'Free', sub: duration };
}

export function YardBoard() {
  const store = useAppStateStore();
  const bayLayout = useAppState((state) => state.bayLayout);
  const bayStates = useAppState((state) => state.bayStates);
  const simRunning = useAppState((state) => state.simRunning);
  const connectionStatus = useAppState((state) => state.connectionStatus);
  const detectionsAtMs = useAppState((state) => state.detectionsAtMs);

  const bays = bayLayout?.bays ?? [];
  // Never zip bays and states positionally: index by bay id (see
  // ParkingBaysPanel — the store may hold states from a previous layout).
  const stateById = new Map(bayStates.map((state) => [state.bayId, state]));

  // `now` at render, no timers: the running sim's per-frame store emits
  // (plus the HUD heartbeat) keep durations and staleness fresh.
  const nowMs = Date.now();
  const issue = trustIssue({ simRunning, connectionStatus, detectionsAtMs, nowMs });

  const toneStyles = {
    occupied: styles.tileOccupied,
    clear: styles.tileClear,
    unknown: styles.tileUnknown,
  } as const;

  return (
    <section className={styles.board} aria-label="Yard board">
      <div className={styles.boardBar}>
        <p className={styles.boardTitle}>Yard board</p>
        <button
          type="button"
          className={styles.dismiss}
          onClick={() => store.setBoardOpen(false)}
        >
          Back to yard
        </button>
      </div>
      {/* auto-fit tracks: one desktop row of large blocks, 2×2 on tablet. */}
      <div className={styles.grid}>
        {bays.map((bay) => {
          const state = stateById.get(bay.id);
          const tile = yardTileCopy(state, nowMs, simRunning, issue);
          return (
            <article
              key={bay.id}
              className={[styles.tile, toneStyles[tile.tone]].filter(Boolean).join(' ')}
              aria-label={`${bayLabel(bay.id)}: ${tile.headline}`}
            >
              <h3 className={styles.tileLabel}>{bayLabel(bay.id)}</h3>
              <p className={styles.tileHeadline}>{tile.headline}</p>
              {tile.sub === null ? null : <p className={styles.tileSub}>{tile.sub}</p>}
            </article>
          );
        })}
      </div>
    </section>
  );
}
