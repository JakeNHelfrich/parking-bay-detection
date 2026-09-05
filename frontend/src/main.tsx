import { createRoot } from 'react-dom/client';
import './style.css';
import { createAppStateStore } from './state/store';
import { App } from './App';

const container = document.querySelector<HTMLDivElement>('#app');
if (!container) throw new Error('#app container missing from index.html');

// Composition root: the single app-state store is created here, once, and
// provided to the tree via React context (see src/state/react.ts). The store
// is the only bridge between the imperative sim pipeline and UI consumers —
// no module-level singletons.
const store = createAppStateStore();

createRoot(container).render(<App store={store} />);