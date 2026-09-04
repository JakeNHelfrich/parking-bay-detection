import * as THREE from 'three';
import {
  BAY_DEPTH,
  BAY_GAP,
  BAY_WIDTH,
  LANE_LENGTH,
  LANE_WIDTH,
  baySlots,
  type BaySlot,
} from './layout';

/**
 * Builds the static lot: ground, lane, and painted bay markings.
 * Returns the bay slots in the same order the markings were laid out.
 */
export function createBayField(scene: THREE.Scene): BaySlot[] {
  scene.add(createGround());
  createLaneMarkings(scene);
  const slots = baySlots();
  for (const slot of slots) {
    scene.add(createBayMarking(slot));
  }
  return slots;
}

function createGround(): THREE.Group {
  const lot = new THREE.Group();

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(180, 120),
    new THREE.MeshStandardMaterial({ color: 0x3f4a3c, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  lot.add(ground);

  // Asphalt pad the lane and bays sit on, slightly above the grass.
  const pad = new THREE.Mesh(
    new THREE.PlaneGeometry(LANE_LENGTH, LANE_WIDTH + 2 * BAY_DEPTH + 1),
    new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.95 }),
  );
  pad.rotation.x = -Math.PI / 2;
  pad.position.y = 0.01;
  pad.receiveShadow = true;
  lot.add(pad);

  return lot;
}

function createLaneMarkings(scene: THREE.Scene): void {
  const dashes = 24;
  const dashLength = LANE_LENGTH / (dashes * 2);
  const material = new THREE.MeshStandardMaterial({ color: 0xf2e14c, roughness: 0.8 });
  const geometry = new THREE.PlaneGeometry(dashLength, 0.25);
  for (let i = 0; i < dashes; i++) {
    const dash = new THREE.Mesh(geometry, material);
    dash.rotation.x = -Math.PI / 2;
    dash.position.set(-LANE_LENGTH / 2 + (2 * i + 1) * dashLength, 0.02, 0);
    dash.receiveShadow = true;
    scene.add(dash);
  }
}

function createBayMarking(slot: BaySlot): THREE.Group {
  const group = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: 0xdcd6c8, roughness: 0.9 });

  // Two side lines (along Z) forming the bay walls.
  const sideGeometry = new THREE.PlaneGeometry(0.18, BAY_DEPTH);
  for (const dx of [-BAY_WIDTH / 2, BAY_WIDTH / 2]) {
    const side = new THREE.Mesh(sideGeometry, paint);
    side.rotation.x = -Math.PI / 2;
    side.position.set(slot.center.x + dx, 0.02, slot.center.z);
    side.receiveShadow = true;
    group.add(side);
  }

  // Back line closing the far end of the bay.
  const backZ = slot.center.z + (slot.side === 'north' ? -BAY_DEPTH / 2 : BAY_DEPTH / 2);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(BAY_WIDTH + BAY_GAP * 0.6, 0.18), paint);
  back.rotation.x = -Math.PI / 2;
  back.position.set(slot.center.x, 0.02, backZ);
  back.receiveShadow = true;
  group.add(back);

  return group;
}