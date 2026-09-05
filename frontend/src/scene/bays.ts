import * as THREE from 'three';
import {
  BAY_DEPTH,
  BAY_GAP,
  BAY_WIDTH,
  LANE_LENGTH,
  LANE_WIDTH,
  PAD_NORTH_EDGE,
  PAD_SOUTH_EDGE,
  baySlots,
  type BaySlot,
} from './layout';

/**
 * Builds the depot lot: grass, mown bands, the asymmetric tarmac pad (bay
 * rank + margin on the north, open kerb on the south), lane paint, and the
 * painted bay markings with numbers. Geometry and numbers are ported from
 * the approved depot mockup (design/scene/depot-mockup.html, day variant).
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

  // Grass field with mown bands for variation under the low sun.
  const grass = new THREE.Mesh(
    new THREE.PlaneGeometry(600, 600),
    new THREE.MeshStandardMaterial({ color: 0x536b3c, roughness: 1 }),
  );
  grass.rotation.x = -Math.PI / 2;
  grass.receiveShadow = true;
  lot.add(grass);

  const bandMaterial = new THREE.MeshStandardMaterial({ color: 0x5c7642, roughness: 1 });
  const bandGeometry = new THREE.PlaneGeometry(600, 7);
  for (let b = 0; b < 7; b++) {
    const band = new THREE.Mesh(bandGeometry, bandMaterial);
    band.rotation.x = -Math.PI / 2;
    band.position.set(0, 0.004, -70 - b * 15);
    band.receiveShadow = true;
    lot.add(band);
  }

  // Asphalt pad: bay rank + working margin on the north (bays sit on it),
  // open kerb side on the south.
  const padDepth = PAD_SOUTH_EDGE - PAD_NORTH_EDGE;
  const pad = new THREE.Mesh(
    new THREE.PlaneGeometry(LANE_LENGTH, padDepth),
    new THREE.MeshStandardMaterial({ color: 0x393c41, roughness: 0.96 }),
  );
  pad.rotation.x = -Math.PI / 2;
  pad.position.set(0, 0.01, (PAD_NORTH_EDGE + PAD_SOUTH_EDGE) / 2);
  pad.receiveShadow = true;
  lot.add(pad);

  // Kerb along the open (south) edge of the pad.
  const kerb = new THREE.Mesh(
    new THREE.BoxGeometry(LANE_LENGTH, 0.34, 0.5),
    new THREE.MeshStandardMaterial({ color: 0xb9b4a8, roughness: 0.9 }),
  );
  kerb.position.set(0, 0.17, PAD_SOUTH_EDGE + 0.25);
  kerb.castShadow = true;
  kerb.receiveShadow = true;
  lot.add(kerb);

  return lot;
}

function createLaneMarkings(scene: THREE.Scene): void {
  const paint = new THREE.MeshStandardMaterial({ color: 0xe4dfcf, roughness: 0.9 });
  const yellow = new THREE.MeshStandardMaterial({ color: 0xf2e14c, roughness: 0.85 });

  // Centreline dashes (2.4 m dash, 2.2 m gap).
  const dashLength = 2.4;
  const step = dashLength * 2.2;
  const dashGeometry = new THREE.PlaneGeometry(dashLength, 0.22);
  for (let d = -LANE_LENGTH / 2; d < LANE_LENGTH / 2; d += step) {
    const dash = new THREE.Mesh(dashGeometry, yellow);
    dash.rotation.x = -Math.PI / 2;
    dash.position.set(d + dashLength / 2, 0.02, 0);
    dash.receiveShadow = true;
    scene.add(dash);
  }

  // Solid lane edges.
  const edgeGeometry = new THREE.PlaneGeometry(LANE_LENGTH, 0.16);
  for (const z of [-LANE_WIDTH / 2, LANE_WIDTH / 2]) {
    const edge = new THREE.Mesh(edgeGeometry, paint);
    edge.rotation.x = -Math.PI / 2;
    edge.position.set(0, 0.02, z);
    edge.receiveShadow = true;
    scene.add(edge);
  }
}

function createBayMarking(slot: BaySlot): THREE.Group {
  const group = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: 0xe4dfcf, roughness: 0.9 });

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
  const back = new THREE.Mesh(new THREE.PlaneGeometry(BAY_WIDTH + BAY_GAP * 0.5, 0.18), paint);
  back.rotation.x = -Math.PI / 2;
  back.position.set(slot.center.x, 0.02, backZ);
  back.receiveShadow = true;
  group.add(back);

  // Painted bay number near the bay mouth, upright when read from the lane
  // camera (north bays face away from the lane, so they rotate a half turn).
  const number = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 1.5),
    new THREE.MeshBasicMaterial({ map: bayNumberTexture(slot.id + 1), transparent: true, depthWrite: false }),
  );
  number.rotation.x = -Math.PI / 2;
  number.rotation.z = slot.side === 'north' ? Math.PI : 0;
  number.position.set(
    slot.center.x,
    0.022,
    slot.center.z + (slot.side === 'north' ? 1 : -1) * (BAY_DEPTH / 2 - 1.2),
  );
  group.add(number);

  return group;
}

/** Canvas-painted two-digit bay number (e.g. "01"), as in the mockup. */
function bayNumberTexture(n: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const g = canvas.getContext('2d');
  if (g) {
    g.clearRect(0, 0, 128, 128);
    g.fillStyle = 'rgba(226,222,208,0.92)';
    g.font = "700 88px 'IBM Plex Mono', monospace";
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(n).padStart(2, '0'), 64, 68);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  return texture;
}
