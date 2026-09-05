/**
 * ParkingBaysPanel — sidebar bay list per design/desktop.png.
 *
 * Read-only over the store's bay data: the bay list comes from
 * `bayLayout.bays` (parsed from the runtime-fetched `bays.json`), per-bay
 * state copy from `bayStates`, so editing `bays.json` changes the panel
 * with no code change (invariant 4). Bay identity comes only from bay ids
 * (invariant 5) — nothing here derives identity from model output.
 *
 * Pure helpers are exported for tests: `bayLabel` (bayId -> "Bay 01") and
 * `bayStatusCopy` (BayState -> state copy per the mockup copywriting).
 */

import { useAppState } from '../state/react';
import type { BayState } from '../bays/occupancy';
import { Card } from './components';
import styles from './ParkingBaysPanel.module.css';

/** Pure label formatter: bayId 0 -> "Bay 01" (1-based, zero-padded). */
export function bayLabel(bayId: number): string {
  return `Bay ${String(bayId + 1).padStart(2, '0')}`;
}

/** Pure copy formatter per the mockup: state + occupancy-confidence bead. */
export function bayStatusCopy(state: BayState): string {
  if (state.occupied) return 'Occupied · truck detected';
  const pct =
    state.confidence === undefined ? '—' : `${Math.round(state.confidence * 100)}%`;
  return `Clear · ${pct} confidence`;
}

export function ParkingBaysPanel() {
  const bayLayout = useAppState((state) => state.bayLayout);
  const bayStates = useAppState((state) => state.bayStates);

  const bays = bayLayout?.bays ?? [];
  // Index BayStates by bay id: the store may hold states computed against a
  // previous layout, so never zip bays and states positionally.
  const stateById = new Map(bayStates.map((state) => [state.bayId, state]));

  return (
    <div className={styles.list}>
      {bays.map((bay) => {
        const state = stateById.get(bay.id);
        const fallback: BayState = { bayId: bay.id, occupied: false };
        return (
          <Card key={bay.id} className={styles.bayCard}>
            <h3 className={styles.bayTitle}>{bayLabel(bay.id)}</h3>
            <p className={styles.bayStatus}>{bayStatusCopy(state ?? fallback)}</p>
          </Card>
        );
      })}
    </div>
  );
}