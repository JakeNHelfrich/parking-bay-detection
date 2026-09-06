/**
 * AppHeader — the header bar: connection status pill, inference health pill,
 * camera chip, and the sim start/stop control. (Brand/logo was removed —
 * bead: remove BAYWATCH wordmark and logo icon — so the header is pure
 * status + controls.)
 *
 * This is an app-level component (not a primitive): it consumes the store via
 * the `src/state/react.ts` adapter. It stays stateless — everything derives
 * from the store snapshot; the start control issues a command
 * (`setSimRunning`) rather than owning state (AGENTS: props in / element out).
 */

import { useAppState, useAppStateStore } from '../state/react';
import type { ConnectionStatus } from '../net/detect-client';
import { CAMERA_ID } from '../config';
import { Button, CameraIcon, Pill } from './components';
import { InferenceStatus } from './InferenceStatus';
import styles from './AppHeader.module.css';

/**
 * Maps every `ConnectionStatus` value to a designed pill state.
 *
 * Per the mockups there is only a "connected" look: `connecting` and `online`
 * both render the green "Live feed connected" pill (the demo feeds starts
 * fast; a distinct connecting state is not designed); `offline` renders the
 * red offline state. Exported for tests.
 */
export function pillForStatus(status: ConnectionStatus): {
  readonly tone: 'ok' | 'danger';
  readonly label: string;
} {
  if (status === 'offline') {
    return { tone: 'danger', label: 'Live feed offline' };
  }
  return { tone: 'ok', label: 'Live feed connected' };
}

export function AppHeader() {
  const store = useAppStateStore();
  const status = useAppState((state) => state.connectionStatus);
  const simRunning = useAppState((state) => state.simRunning);
  const view = useAppState((state) => state.view);
  const boardOpen = useAppState((state) => state.boardOpen);
  const pill = pillForStatus(status);

  return (
    <header className={styles.header}>
      <div className={styles.actions}>
        {/* Pills + chip stay grouped so mobile can restack pill + chip /
            start button as two rows while desktop keeps one row. */}
        <div className={styles.metaRow}>
          <Pill tone={pill.tone}>{pill.label}</Pill>
          {/* Inference health lives in the header too (bead: move inference
              health to top bar) so both status signals form one cluster. */}
          <InferenceStatus />
          <Button variant="ghost" className={styles.chip} aria-label={`Camera ${CAMERA_ID}`}>
            <CameraIcon size={15} />
            {CAMERA_ID}
          </Button>
        </div>
        {/* View toggle (rzo.4): live yard ↔ history board. The sim pipeline
            unmounts while history is open and remounts on return — its
            lifecycle is effect-owned, `simRunning` persists in the store. */}
        <div className={styles.viewControls}>
          <Button variant="ghost" onClick={() => store.setView(view === 'history' ? 'live' : 'history')}>
            {view === 'history' ? 'Back to live' : 'History'}
          </Button>
          {/* Yard board toggle (yp6.4): overlays the glanceable board above the
              live view (sim keeps running underneath); dismissed from the
              board's own control or here. */}
          <Button variant="ghost" onClick={() => store.setBoardOpen(!boardOpen)}>
            {boardOpen ? 'Back to yard' : 'Yard board'}
          </Button>
          <Button onClick={() => store.setSimRunning(!simRunning)}>
            {simRunning ? 'Stop simulation' : 'Start simulation'}
          </Button>
        </div>
      </div>
    </header>
  );
}