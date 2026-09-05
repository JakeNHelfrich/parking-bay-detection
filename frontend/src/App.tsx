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
 */

import { useEffect, useRef } from 'react';
import { AppStateProvider } from './state/react';
import type { AppStateStore } from './state/store';
import { mountSim } from './sim/bootstrap';
import { LogoMark } from './ui/components';
import styles from './App.module.css';

interface AppProps {
  readonly store: AppStateStore;
}

export function App({ store }: AppProps) {
  const simHostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = simHostRef.current;
    if (host === null) return;
    return mountSim(host, store);
  }, [store]);

  return (
    <AppStateProvider store={store}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div className={styles.brand}>
            <span className={styles.logoTile}>
              <LogoMark size={18} />
            </span>
            <span className={styles.wordmark}>BAYWATCH</span>
          </div>
          {/* Header actions (status pill, camera selector, start button) are
              wired to the store in a later bead. */}
        </header>
        <main className={styles.main}>
          <section className={styles.viewportPanel} aria-label="Simulator viewport">
            <div className={styles.simHost} ref={simHostRef} />
          </section>
          <aside className={styles.sidebar} aria-label="Parking bays">
            <div className={styles.sidebarHeading}>
              <h2 className={styles.sidebarTitle}>Parking bays</h2>
            </div>
            {/* Bay cards are wired to the store in a later bead. */}
          </aside>
        </main>
      </div>
    </AppStateProvider>
  );
}