import './style.css';
import { createBayField } from './scene/bays';
import { TruckSimulator } from './scene/truck-simulator';
import { createWorld } from './scene/world';

const container = document.querySelector<HTMLDivElement>('#app');
if (!container) throw new Error('#app container missing from index.html');

const world = createWorld(container);
const bays = createBayField(world.scene);
const simulator = new TruckSimulator(world.scene, bays);

// Render loop. Detection integration (capture → WS → overlay) lands in M3;
// the loop stays non-blocking by design so nothing here may await inference.
let last = performance.now();
function frame(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  simulator.update(dt);
  world.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);