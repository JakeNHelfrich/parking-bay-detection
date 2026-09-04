import * as THREE from 'three';
import { LANE_LENGTH, bayHeading, type BaySlot } from './layout';
import { buildTruckMesh } from './truck';

/**
 * Truck actor: a deterministic state machine that drives in along the lane,
 * parks in its assigned bay, dwells, then departs and despawns.
 *
 * Phases:
 *   approach — move along the lane at constant speed until aligned with the bay
 *   parking  — eased tween from lane into the bay (position + yaw)
 *   parked   — dwell for a fixed duration
 *   leaving  — eased tween back out to the lane
 *   exiting  — drive along the lane until past the lot edge, then despawn
 *
 * Determinism: no Math.random anywhere; behavior is a pure function of
 * (dt, spawn order) so scripted cycles are reproducible for testing.
 */

export type TruckPhase = 'approach' | 'parking' | 'parked' | 'leaving' | 'exit';

const LANE_SPEED = 9; // world units / s along the lane
const PARK_DURATION = 8; // seconds a truck stays parked
const TWEEN_DURATION = 2.2; // seconds for the in/out-of-bay maneuver

export class TruckActor {
  readonly mesh: THREE.Group;
  readonly bay: BaySlot;
  private _phase: TruckPhase = 'approach';
  private phaseTime = 0;
  private readonly dir: 1 | -1; // lane travel direction (+1 = west→east)
  private readonly travelYaw: number;

  constructor(bay: BaySlot, dir: 1 | -1, colorIndex: number) {
    this.bay = bay;
    this.dir = dir;
    this.mesh = buildTruckMesh(colorIndex);
    // Spawn just outside the lot edge on the approach side.
    this.mesh.position.set((-dir * LANE_LENGTH) / 2, 0, 0);
    // Lane runs along X; base yaw faces the travel direction.
    this.travelYaw = dir === 1 ? 0 : Math.PI;
    this.mesh.rotation.y = this.travelYaw;
  }

  /** Current phase, readable by the simulator and future occupancy logic. */
  get phase(): TruckPhase {
    return this._phase;
  }

  /** Advances the actor. Returns false once the truck has left the lot. */
  update(dt: number): boolean {
    this.phaseTime += dt;
    switch (this._phase) {
      case 'approach': {
        this.advanceLane(dt);
        const reached = this.dir === 1
          ? this.mesh.position.x >= this.bay.center.x
          : this.mesh.position.x <= this.bay.center.x;
        if (reached) this.beginPhase('parking');
        return true;
      }
      case 'parking': {
        const t = clamp01(this.phaseTime / TWEEN_DURATION);
        const e = easeInOut(t);
        this.mesh.position.z = this.bay.center.z * e;
        this.mesh.rotation.y = lerp(this.travelYaw, bayHeading(this.bay.side), e);
        if (t >= 1) this.beginPhase('parked');
        return true;
      }
      case 'parked': {
        if (this.phaseTime >= PARK_DURATION) this.beginPhase('leaving');
        return true;
      }
      case 'leaving': {
        const t = clamp01(this.phaseTime / TWEEN_DURATION);
        const e = easeInOut(t);
        this.mesh.position.z = this.bay.center.z * (1 - e);
        this.mesh.rotation.y = lerp(bayHeading(this.bay.side), this.travelYaw, e);
        if (t >= 1) this.beginPhase('exit');
        return true;
      }
      case 'exit': {
        this.advanceLane(dt);
        return Math.abs(this.mesh.position.x) <= LANE_LENGTH / 2 + 10;
      }
    }
  }

  private advanceLane(dt: number): void {
    this.mesh.position.x += this.dir * LANE_SPEED * dt;
  }

  private beginPhase(phase: TruckPhase): void {
    this._phase = phase;
    this.phaseTime = 0;
  }

  dispose(): void {
    this.mesh.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        if (obj.material instanceof THREE.Material) obj.material.dispose();
      }
    });
  }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
function easeInOut(t: number): number {
  return t * t * (3 - 2 * t);
}
function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}