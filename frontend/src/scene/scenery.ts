import * as THREE from 'three';
import { PAD_NORTH_EDGE, PAD_SOUTH_EDGE, type BaySlot } from './layout';

/**
 * Depot scenery behind and around the lot: warehouse dock wall with doors
 * aligned to the bays, mast lights, boundary fence + hedge, treeline, and
 * distant hills. Ported from the approved mockup's buildScenery()
 * (design/scene/depot-mockup.html, day variant; yard clutter was not part of
 * the approved scope). All randomness is deterministic so the yard is
 * identical on every rebuild.
 */

/** Deterministic pseudo-random in [0, 1) — same sequence as the mockup. */
function rnd(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function mat(color: number, roughness: number, metalness = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

/** Shadow-casting axis-aligned box, positioned in the parent's space. */
function box(
  w: number,
  h: number,
  d: number,
  material: THREE.Material,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Crosshatch chain-link alpha texture, repeated along the fence plane. */
function fenceTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const g = canvas.getContext('2d');
  if (g) {
    g.strokeStyle = '#ffffff';
    g.lineWidth = 4;
    g.beginPath();
    for (let i = -64; i < 128; i += 16) {
      g.moveTo(i, 0);
      g.lineTo(i + 64, 64);
      g.moveTo(i, 64);
      g.lineTo(i + 64, 0);
    }
    g.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/**
 * Builds the static depot scenery into the scene. Dock doors and bumpers are
 * aligned with the north-side bay slots; everything else is placed relative
 * to the pad edges from layout.ts.
 */
export function createDepotScenery(scene: THREE.Scene, slots: readonly BaySlot[]): void {
  const wallZ = PAD_NORTH_EDGE - 1.2;
  const scenery = new THREE.Group();

  buildWarehouse(scenery, slots, wallZ);
  buildMastLights(scenery);
  buildFenceAndHedge(scenery);
  buildTreeline(scenery, wallZ);
  buildHills(scenery, wallZ);

  scene.add(scenery);
}

function buildWarehouse(group: THREE.Group, slots: readonly BaySlot[], wallZ: number): void {
  const shell = mat(0xb9c0c4, 0.85);
  const trim = mat(0x2f6b82, 0.7);
  const door = mat(0x33373c, 0.8);
  const bumper = mat(0x1b1d20, 0.95);
  const plant = mat(0x9aa2a6, 0.9);

  const W = 62;
  const H = 11;
  const D = 26;
  const whZ = wallZ - D / 2;

  group.add(box(W, H, D, shell, 0, H / 2, whZ));
  // Roof band + parapet.
  group.add(box(W + 0.8, 0.9, D + 0.8, trim, 0, H + 0.3, whZ));
  // Canopy over the dock face.
  group.add(box(W, 0.5, 3.4, trim, 0, 5.6, wallZ + 1.4));

  // Dock doors aligned with the north bays.
  for (const slot of slots) {
    if (slot.side !== 'north') continue;
    group.add(box(3.1, 4.2, 0.3, door, slot.center.x, 2.1, wallZ + 0.05));
    group.add(box(0.4, 0.5, 0.4, bumper, slot.center.x - 1.8, 1.0, wallZ + 0.25));
    group.add(box(0.4, 0.5, 0.4, bumper, slot.center.x + 1.8, 1.0, wallZ + 0.25));
  }

  // Roof plant.
  group.add(box(4, 1.4, 3, plant, -16, H + 1.2, wallZ - 12));
  group.add(box(3, 1.1, 3, plant, 12, H + 1.05, wallZ - 16));
}

function buildMastLights(group: THREE.Group): void {
  const mastMaterial = mat(0x6d7479, 0.7, 0.3);
  const headMaterial = mat(0xd8dcdf, 0.6);

  const poleGeometry = new THREE.CylinderGeometry(0.16, 0.24, 12, 8);
  const headGeometry = new THREE.BoxGeometry(2.4, 0.35, 0.9);

  for (const side of [-1, 1]) {
    for (let j = 0; j < 3; j++) {
      const mast = new THREE.Group();
      const pole = new THREE.Mesh(poleGeometry, mastMaterial);
      pole.position.y = 6;
      pole.castShadow = true;
      mast.add(pole);
      const head = new THREE.Mesh(headGeometry, headMaterial);
      head.position.set(0, 12.1, 0.5);
      mast.add(head);
      mast.position.set(side * (21 + j * 16), 0, PAD_SOUTH_EDGE + 4.5);
      group.add(mast);
    }
  }
}

function buildFenceAndHedge(group: THREE.Group): void {
  const fenceTextureMap = fenceTexture();
  fenceTextureMap.repeat.set(46, 1.4);
  const fence = new THREE.Mesh(
    new THREE.PlaneGeometry(160, 2.6),
    new THREE.MeshBasicMaterial({
      map: fenceTextureMap,
      alphaMap: fenceTextureMap,
      transparent: true,
      opacity: 0.34,
      color: 0xc8ced2,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  fence.position.set(0, 1.3, PAD_SOUTH_EDGE + 7);
  group.add(fence);

  const postMaterial = mat(0x767c80, 0.8);
  const postGeometry = new THREE.CylinderGeometry(0.09, 0.09, 2.7, 6);
  for (let p = -80; p <= 80; p += 8) {
    const post = new THREE.Mesh(postGeometry, postMaterial);
    post.position.set(p, 1.35, PAD_SOUTH_EDGE + 7);
    group.add(post);
  }

  const leafA = mat(0x3d6030, 1);
  const leafB = mat(0x4a7038, 1);
  for (let h = 0; h < 30; h++) {
    const hx = -100 + h * 7 + rnd(h + 5) * 2;
    group.add(box(6.4, 1.8 + rnd(h) * 0.5, 1.9, h % 2 ? leafA : leafB, hx, 0.9, PAD_SOUTH_EDGE + 10));
  }
}

function buildTreeline(group: THREE.Group, wallZ: number): void {
  const trunkMaterial = mat(0x453423, 1);
  const leafA = mat(0x3d6030, 1);
  const leafB = mat(0x4a7038, 1);

  for (let t = 0; t < 26; t++) {
    const r1 = rnd(t);
    const r2 = rnd(t + 40);
    const r3 = rnd(t + 80);
    const tx = -110 + t * 8.6 + r1 * 5;
    const tz = wallZ - 34 - r2 * 26;
    const height = 6 + r3 * 5;

    const tree = new THREE.Group();
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.32, 0.42, height * 0.45, 6),
      trunkMaterial,
    );
    trunk.position.y = height * 0.22;
    tree.add(trunk);
    const crown = new THREE.Mesh(
      new THREE.ConeGeometry(2.2 + r1 * 1.4, height * 0.85, 7),
      r2 > 0.5 ? leafA : leafB,
    );
    crown.position.y = height * 0.62;
    crown.castShadow = true;
    tree.add(crown);
    tree.position.set(tx, 0, tz);
    group.add(tree);
  }
}

function buildHills(group: THREE.Group, wallZ: number): void {
  const hillMaterial = mat(0x7f9a90, 1);
  for (let q = 0; q < 5; q++) {
    const hill = new THREE.Mesh(new THREE.SphereGeometry(46 + q * 12, 14, 8), hillMaterial);
    hill.scale.set(1.6, 0.24 + rnd(q) * 0.12, 1);
    hill.position.set(-140 + q * 74, -4, wallZ - 190 - rnd(q + 9) * 40);
    group.add(hill);
  }
}
