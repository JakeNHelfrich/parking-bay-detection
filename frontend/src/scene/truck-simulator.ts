import * as THREE from 'three';
import type { BaySlot } from './layout';
import { TruckActor } from './truck-actor';

/**
 * Spawn scheduler for truck actors.
 *
 * Deterministic scripted cycle: every SPAWN_INTERVAL seconds it claims the
 * next free bay in a rotating order and alternates approach direction, so
 * the run is reproducible. No randomness.
 */

const SPAWN_INTERVAL = 5; // seconds between spawns
// Mockup far4 cap: fewer active actors than bays so the lane never gridlocks
// and every swing into a bay has clear road.
const MAX_ACTIVE = 3;

export class TruckSimulator {
  private readonly actors: TruckActor[] = [];
  private nextSpawn = 1; // small delay before the first truck appears
  private nextBayIndex = 0;

  private readonly scene: THREE.Scene;
  private readonly bays: readonly BaySlot[];

  constructor(scene: THREE.Scene, bays: readonly BaySlot[]) {
    this.scene = scene;
    this.bays = bays;
  }

  update(dt: number): void {
    this.nextSpawn -= dt;
    if (this.nextSpawn <= 0 && this.actors.length < MAX_ACTIVE) {
      this.spawn();
      this.nextSpawn = SPAWN_INTERVAL;
    }

    for (let i = this.actors.length - 1; i >= 0; i--) {
      const actor = this.actors[i];
      if (!actor.update(dt)) {
        actor.dispose();
        this.scene.remove(actor.mesh);
        this.actors.splice(i, 1);
      }
    }
  }

  /** Bay ids currently occupied by a parked or parking truck. */
  occupiedBayIds(): ReadonlySet<number> {
    const ids = new Set<number>();
    for (const actor of this.actors) {
      if (actor.phase !== 'exit') ids.add(actor.bay.id);
    }
    return ids;
  }

  /** Root meshes of all active trucks (used by the `?gt` dataset capture). */
  truckMeshes(): readonly THREE.Group[] {
    return this.actors.map((actor) => actor.mesh);
  }

  activeCount(): number {
    return this.actors.length;
  }

  private spawn(): void {
    const occupied = this.occupiedBayIds();
    // Rotate through bays deterministically; skip any still occupied.
    for (let step = 0; step < this.bays.length; step++) {
      const index = (this.nextBayIndex + step) % this.bays.length;
      const bay = this.bays[index];
      if (!occupied.has(bay.id)) {
        this.nextBayIndex = (index + 1) % this.bays.length;
        const dir: 1 | -1 = index % 2 === 0 ? 1 : -1;
        const actor = new TruckActor(bay, dir, index);
        this.scene.add(actor.mesh);
        this.actors.push(actor);
        return;
      }
    }
    // Every bay occupied; try again after the next interval.
  }
}