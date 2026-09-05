/**
 * React adapter for the app state store (UI boundary prep).
 *
 * Components consume app state via `useAppState(selector)` without
 * prop-drilling from `main.ts`. The store instance itself is created once in
 * `main.ts` (the composition root) and provided through React context via
 * `<AppStateProvider store={...}>` — there is deliberately NO module-level
 * store singleton (AGENTS invariant: no hidden module-level mutable state).
 *
 * Caveat: `useSyncExternalStore` re-runs the selector on every notification
 * and compares with `Object.is`. Selectors must return primitives or
 * reference-stable values (every field of `AppState` is an immutable
 * reference, so selecting a whole field is safe; never return freshly built
 * objects/arrays from a selector).
 */

import {
  createContext,
  createElement,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { AppState, AppStateStore } from './store';

const AppStateContext = createContext<AppStateStore | null>(null);

/** Provides the (single, main.ts-owned) store instance to the React tree. */
export function AppStateProvider(props: { readonly store: AppStateStore; readonly children: ReactNode }): ReactNode {
  return createElement(AppStateContext.Provider, { value: props.store }, props.children);
}

/** Returns the store itself (for imperative one-off reads/commands). */
export function useAppStateStore(): AppStateStore {
  const store = useContext(AppStateContext);
  if (store === null) {
    throw new Error('useAppState* used outside <AppStateProvider>');
  }
  return store;
}

/**
 * Subscribes to a slice of app state. See the module caveat: the selector
 * must return a primitive or a reference-stable value.
 */
export function useAppState<T>(selector: (state: AppState) => T): T {
  const store = useAppStateStore();
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
  );
}
