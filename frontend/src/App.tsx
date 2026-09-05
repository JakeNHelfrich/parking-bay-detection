/**
 * App root: the BAYWATCH shell (header / viewport / sidebar) with the
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
 * viewport shows the placeholder from the mockups; the header button toggles
 * `simRunning` in the store (a command into the store, not component state)
 * and flips between Start/Stop.
 */

import { useEffect, useRef } from 'react';
import { AppStateProvider, useAppState, useAppStateStore } from './state/react';
import type { AppStateStore } from './state/store';
import { mountSim } from './sim/bootstrap';
import { Button, CameraIcon, LogoMark } from './ui/components';
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

  useEffect(() => {
    const host = simHostRef.current;
    if (host === null) return;
    return mountSim(host, store);
  }, [store]);

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.logoTile}>
            <LogoMark size={18} />
          </span>
          <span className={styles.wordmark}>BAYWATCH</span>
        </div>
        <SimToggleButton simRunning={simRunning} />
      </header>
      <main className={styles.main}>
        <section className={styles.viewportPanel} aria-label="Simulator viewport">
          <div className={styles.simHost} ref={simHostRef} />
          {simRunning ? null : <ViewportPlaceholder />}
        </section>
        <aside className={styles.sidebar} aria-label="Parking bays">
          <div className={styles.sidebarHeading}>
            <h2 className={styles.sidebarTitle}>Parking bays</h2>
          </div>
          {/* Bay cards are wired to the store in a later bead. */}
        </aside>
      </main>
    </div>
  );
}

/** Header control that starts/stops the simulation via the store. */
function SimToggleButton({ simRunning }: { readonly simRunning: boolean }) {
  const store = useAppStateStore();
  return (
    <Button onClick={() => store.setSimRunning(!simRunning)}>
      {simRunning ? 'Stop simulation' : 'Start simulation'}
    </Button>
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