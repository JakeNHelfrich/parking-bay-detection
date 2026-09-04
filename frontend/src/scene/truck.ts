import * as THREE from 'three';

const TRUCK_LENGTH = 4.6; // along local X (nose at +x)
const TRUCK_WIDTH = 2.0; // along local Z
const WHEEL_RADIUS = 0.42;

const PALETTE = [0xb43a3a, 0x2f6fb4, 0xd18f2f, 0x3f8f5f, 0x6a5aa8, 0x7a7f87];

/**
 * Builds a simple low-poly truck with its nose pointing along local +X.
 * Shared geometries are reused across wheels to keep draw setup light.
 */
export function buildTruckMesh(colorIndex: number): THREE.Group {
  const truck = new THREE.Group();
  const color = PALETTE[colorIndex % PALETTE.length];
  const bodyMaterial = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1 });
  const darkMaterial = new THREE.MeshStandardMaterial({ color: 0x1c1c20, roughness: 0.9 });

  const chassis = new THREE.Mesh(
    new THREE.BoxGeometry(TRUCK_LENGTH * 0.62, 0.9, TRUCK_WIDTH),
    bodyMaterial,
  );
  chassis.position.set(-TRUCK_LENGTH * 0.16, 1.05, 0);
  chassis.castShadow = true;
  truck.add(chassis);

  const cab = new THREE.Mesh(
    new THREE.BoxGeometry(TRUCK_LENGTH * 0.3, 1.25, TRUCK_WIDTH),
    bodyMaterial,
  );
  cab.position.set(TRUCK_LENGTH * 0.33, 1.15, 0);
  cab.castShadow = true;
  truck.add(cab);

  const windshield = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.55, TRUCK_WIDTH * 0.82),
    new THREE.MeshStandardMaterial({ color: 0x9fd4e8, roughness: 0.2, metalness: 0.4 }),
  );
  windshield.position.set(TRUCK_LENGTH * 0.465, 1.35, 0);
  truck.add(windshield);

  // Six wheels: three axles (front, middle, rear).
  const wheelGeometry = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.35, 16);
  wheelGeometry.rotateX(Math.PI / 2);
  const wheelX = [TRUCK_LENGTH * 0.33, -TRUCK_LENGTH * 0.28, -TRUCK_LENGTH * 0.42];
  for (const wx of wheelX) {
    for (const wz of [-TRUCK_WIDTH / 2, TRUCK_WIDTH / 2]) {
      const wheel = new THREE.Mesh(wheelGeometry, darkMaterial);
      wheel.position.set(wx, WHEEL_RADIUS, wz);
      wheel.castShadow = true;
      truck.add(wheel);
    }
  }

  return truck;
}

export const TRUCK_DIMENSIONS = { length: TRUCK_LENGTH, width: TRUCK_WIDTH };