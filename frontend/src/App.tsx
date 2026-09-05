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
import { AppHeader } from './ui/AppHeader';
import { ParkingBaysPanel } from './ui/ParkingBaysPanel';
import { CameraIcon } from './ui/components';
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

  return (
    <div className={styles.shell}>
      <AppHeader />
      <main className={styles.main}>
        <section className={styles.viewportPanel} aria-label="Simulator viewport">
          <div className={styles.simHost} ref={simHostRef} />
          {simRunning ? null : <ViewportPlaceholder />}
        </section>
        <aside className={styles.sidebar} aria-label="Parking bays">
          <div className={styles.sidebarHeading}>
            <h2 className={styles.sidebarTitle}>Parking bays</h2>
            {/* N derives from bays.json at runtime — no code change to re-bay. */}
            <span className={styles.sidebarMeta}>{bayLayout?.bays.length ?? 0} monitored</span>
          </div>
          <ParkingBaysPanel />
        </aside>
      </main>
    </div>
  );
}

/** Mockup placeholder shown in the viewport while the sim is not running. */
function ViewportPlaceholder() {
  return (
    <div className={styles.placeholder} role="status">
      <span className={styles.placeholderIcon}>
        <CameraIcon size={22} />
      </span>
      <h1 className={styles.placeholderHeadline}>Simulator view ready</h1>
      <p className={styles.placeholderCopy}>
        Connect your live computer-vision canvas here. Detection zones, truck
        paths, and bay overlays will remain the focal point.
      </p>
    </div>
  );
}