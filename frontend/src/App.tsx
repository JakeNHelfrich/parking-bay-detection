/**
 * App root: the app shell (header / viewport / sidebar) with the
 * imperative sim pipeline mounted inside the viewport panel.
 *
 * The store comes in as a prop from the composition root (`main.tsx`) and is
 * provided via context (`AppStateProvider`). World + Overlay mount into the
 * viewport panel's sim host through a ref + effect (`mountSim`) — glue, not
 * component state — and their lifecycle is owned by this component: the
 * returned dispose runs on unmount. Panel sizing uses ResizeObserver inside
 * world.ts/overlay.ts, so the 16:9 letterbox tracks the panel, not the window.
 *
 * Sim lifecycle (bead 6kh): the sim does not auto-run. Until started, the
 * viewport shows the placeholder from the mockups; the header control (now in
 * `AppHeader`, bead: header UI) toggles `simRunning` in the store and flips
 * between Start/Stop.
 */

import { useEffect, useRef } from 'react';
import { AppStateProvider, useAppState, useAppStateStore } from './state/react';
import type { AppStateStore } from './state/store';
import { mountSim } from './sim/bootstrap';
import {
  createAlertsClient,
  resolveAlertsApiBase,
  type AlertsClient,
} from './net/alerts-api';
import { startAlertPolling, type AlertPolling } from './sim/alert-polling';
import { AlertsPanel } from './ui/AlertsPanel';
import { AppHeader } from './ui/AppHeader';
import { ParkingBaysPanel } from './ui/ParkingBaysPanel';
import { PlayIcon } from './ui/components';
import styles from './App.module.css';

interface AppProps {
  readonly store: AppStateStore;
}

export function App({ store }: AppProps) {
  return (
    <AppStateProvider store={store}>
      <Shell />
    </AppStateProvider>
  );
}

function Shell() {
  const simHostRef = useRef<HTMLDivElement>(null);
  const store = useAppStateStore();
  const simRunning = useAppState((state) => state.simRunning);
  const bayLayout = useAppState((state) => state.bayLayout);

  useEffect(() => {
    const host = simHostRef.current;
    if (host === null) return;
    return mountSim(host, store);
  }, [store]);

  // Alert polling (bead rzo.5) is independent of the sim lifecycle: the
  // yard's durable record is live whether or not the render loop is running.
  const pollingRef = useRef<AlertPolling | null>(null);
  useEffect(() => {
    const base = resolveAlertsApiBase(import.meta.env.VITE_ALERTS_API_URL, window.location);
    const client: AlertsClient = createAlertsClient(base);
    const polling = startAlertPolling(store, client);
    pollingRef.current = polling;
    return () => {
      polling.dispose();
      pollingRef.current = null;
    };
  }, [store]);

  return (
    <div className={styles.shell}>
      <AppHeader />
      <main className={styles.main}>
        <section className={styles.viewportPanel} aria-label="Simulator viewport">
          <div className={styles.simHost} ref={simHostRef} />
          {simRunning ? null : (
            <ViewportPlaceholder onStart={() => store.setSimRunning(true)} />
          )}
        </section>
        <aside className={styles.sidebar} aria-label="Parking bays">
          <div className={styles.sidebarHeading}>
            <h2 className={styles.sidebarTitle}>Parking bays</h2>
            {/* N derives from bays.json at runtime — no code change to re-bay. */}
            <span className={styles.sidebarMeta}>{bayLayout?.bays.length ?? 0} monitored</span>
          </div>
          <ParkingBaysPanel />
          {/* In-app notification area (rzo.5): durable alerts from the record.
              Renders only when there is news; acks dispatch via polling glue. */}
          <AlertsAreaShell onAcknowledge={(id) => pollingRef.current?.acknowledge(id)} />
        </aside>
      </main>
    </div>
  );
}

/**
 * Sidebar notification area: reads the alerts snapshot from the store and
 * dispatches acknowledgements through the polling glue (ack is optimistic —
 * see `alert-polling.ts`). `now` is taken at render time: the store
 * re-renders on every poll (15s), which is the freshness the coarse age
 * copy needs.
 */
function AlertsAreaShell(props: { readonly onAcknowledge: (id: number) => void }) {
  const alerts = useAppState((state) => state.alerts);
  const alertsError = useAppState((state) => state.alertsError);
  return (
    <AlertsPanel
      alerts={alerts}
      error={alertsError}
      now={new Date()}
      onAcknowledge={props.onAcknowledge}
    />
  );
}

/**
 * Idle-viewport start CTA (parking-bay-detection-tdq): until the sim runs,
 * the whole viewport IS the start button — a video-player-style empty state
 * (circular play icon + title + subline) over a scrim, so the affordance
 * sits where the eye already is and idle vs running is unmistakable.
 * Dispatches the same store command as the header toggle; once running,
 * this leaves the tree and the header shows Stop.
 */
function ViewportPlaceholder(props: { readonly onStart: () => void }) {
  return (
    <button
      type="button"
      className={styles.placeholder}
      onClick={props.onStart}
      aria-label="Start simulation"
    >
      <span className={styles.placeholderPlay} aria-hidden="true">
        <PlayIcon size={30} />
      </span>
      <h1 className={styles.placeholderHeadline}>Start simulation</h1>
      <p className={styles.placeholderCopy}>
        Run the depot yard to begin truck traffic and watch bay occupancy
        update live.
      </p>
    </button>
  );
}