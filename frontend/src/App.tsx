/**
 * App root: composition of the React shell and the imperative sim pipeline.
 *
 * The store comes in as a prop from the composition root (`main.tsx`) and is
 * provided via context (`AppStateProvider`). The three.js/WS pipeline is
 * mounted through a ref + effect (`mountSim`) — it is glue, not component
 * state, and it publishes UI-relevant facts into the store.
 */

import { useEffect, useRef } from 'react';
import { AppStateProvider } from './state/react';
import type { AppStateStore } from './state/store';
import { mountSim } from './sim/bootstrap';
import styles from './App.module.css';

interface AppProps {
  readonly store: AppStateStore;
}

export function App({ store }: AppProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    return mountSim(host, store);
  }, [store]);

  return (
    <AppStateProvider store={store}>
      <div className={styles.simHost} ref={hostRef} />
    </AppStateProvider>
  );
}