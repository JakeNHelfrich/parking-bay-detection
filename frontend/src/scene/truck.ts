import * as THREE from 'three';

const TRUCK_LENGTH = 7.2; // along local X (nose at +x)
const TRUCK_WIDTH = 2.5; // along local Z
const WHEEL_RADIUS = 0.55;

const PALETTE = [0xb43a3a, 0x2f6fb4, 0xd18f2f, 0x3f8f5f, 0x6a5aa8];

function mat(color: number, roughness: number, metalness = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

/** Axis-aligned box helper; shadow casting on so the truck grounds the scene. */
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

interface WheelSetOptions {
  /** Wheel centre X positions (one axle each). */
  xs: number[];
  /** Half track width — wheels sit at ±halfW on Z. */
  halfW: number;
  radius: number;
  width: number;
}

/**
 * Tyres with visible hub faces. Geometries are created once per set and
 * shared across every axle/side, keeping per-truck draw setup light.
 */
function wheelSet(group: THREE.Group, options: WheelSetOptions): void {
  const tyre = mat(0x15171a, 0.95);
  const hub = mat(0x9aa0a6, 0.5, 0.6);
  const { xs, halfW, radius, width } = options;

  const tyreGeometry = new THREE.CylinderGeometry(radius, radius, width, 18);
  tyreGeometry.rotateX(Math.PI / 2);
  const hubGeometry = new THREE.CylinderGeometry(radius * 0.48, radius * 0.48, width + 0.06, 12);
  hubGeometry.rotateX(Math.PI / 2);

  for (const wx of xs) {
    for (const wz of [-halfW, halfW]) {
      const wheel = new THREE.Mesh(tyreGeometry, tyre);
      wheel.position.set(wx, radius, wz);
      wheel.castShadow = true;
      group.add(wheel);

      const face = new THREE.Mesh(hubGeometry, hub);
      face.position.set(wx, radius, wz + (wz > 0 ? 0.03 : -0.03));
      group.add(face);
    }
  }
}

interface CabOptions {
  sleeper?: boolean;
  stack?: boolean;
}

/**
 * Day cab (or sleeper tractor) assembly: nose at local +X, group centred on
 * x=0. Returns the assembled group plus the dimensions callers need to place it.
 */
function cabAssembly(
  colorIndex: number,
  options: CabOptions,
): { group: THREE.Group; width: number; cabLen: number } {
  const g = new THREE.Group();
  const body = mat(PALETTE[colorIndex % PALETTE.length], 0.45, 0.25);
  const glass = new THREE.MeshStandardMaterial({ color: 0x1e2f38, roughness: 0.12, metalness: 0.75 });
  const dark = mat(0x24262a, 0.8);
  const chrome = mat(0xb6bcc2, 0.35, 0.85);
  const lamp = new THREE.MeshStandardMaterial({ color: 0xfff2cf, emissive: 0xffe8b0, emissiveIntensity: 0.8, roughness: 0.3 });
  const amber = new THREE.MeshStandardMaterial({ color: 0xffb347, emissive: 0xff9b1f, emissiveIntensity: 0.7, roughness: 0.4 });
  const W = 2.5;

  const cabLen = options.sleeper ? 3.0 : 2.1;
  g.add(box(cabLen, 2.35, W, body, 0, 2.05, 0));

  // Windscreen + side glass.
  g.add(box(0.1, 0.95, W * 0.88, glass, cabLen / 2 + 0.02, 2.55, 0));
  g.add(box(cabLen * 0.42, 0.8, W + 0.04, glass, cabLen * 0.12, 2.5, 0));

  // Sloped roof deflector.
  const deflector = box(cabLen * 0.72, 0.62, W * 0.92, body, -cabLen * 0.06, 3.42, 0);
  deflector.rotation.z = -0.09;
  g.add(deflector);

  // Amber roof marker lamps (shared geometry across the three lamps).
  const markerGeometry = new THREE.BoxGeometry(0.16, 0.1, 0.16);
  for (const mk of [-1, 0, 1]) {
    const marker = new THREE.Mesh(markerGeometry, amber);
    marker.position.set(cabLen * 0.2, 3.75, mk * 0.8);
    g.add(marker);
  }

  // Grille, chrome bumper, headlamps.
  g.add(box(0.14, 0.75, W * 0.8, dark, cabLen / 2 + 0.03, 1.55, 0));
  g.add(box(0.34, 0.42, W + 0.08, chrome, cabLen / 2 + 0.12, 0.95, 0));
  const lampGeometry = new THREE.BoxGeometry(0.12, 0.26, 0.5);
  for (const sgn of [-1, 1]) {
    const headlamp = new THREE.Mesh(lampGeometry, lamp);
    headlamp.position.set(cabLen / 2 + 0.2, 1.05, sgn * 0.92);
    g.add(headlamp);
  }

  // Mirrors.
  for (const sgn of [-1, 1]) {
    g.add(box(0.08, 0.62, 0.16, dark, cabLen / 2 - 0.15, 2.6, sgn * (W / 2 + 0.28)));
    g.add(box(0.5, 0.06, 0.06, dark, cabLen / 2 - 0.35, 2.85, sgn * (W / 2 + 0.16)));
  }

  // Exhaust stack (sleeper cabs only).
  if (options.stack) {
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 2.6, 10), chrome);
    stack.position.set(-cabLen / 2 + 0.1, 2.4, -(W / 2 - 0.2));
    stack.castShadow = true;
    g.add(stack);
  }

  // Fuel tank.
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.5, 12), chrome);
  tank.rotation.z = Math.PI / 2;
  tank.position.set(-cabLen * 0.2, 0.85, -(W / 2 - 0.05));
  tank.castShadow = true;
  g.add(tank);

  return { group: g, width: W, cabLen };
}

/**
 * Builds the rigid box truck from the approved depot mockup: chassis rails,
 * day cab with roof deflector, ribbed box body with livery band, rear doors,
 * tail lamps, mudflaps, and hubbed wheels on three axles (front + rear tandem).
 * Nose points along local +X so actor tweens keep their heading math.
 * Shared geometries are reused across ribs and wheels to keep per-frame cost
 * low (the render loop doubles as the capture source).
 */
export function buildTruckMesh(colorIndex: number): THREE.Group {
  const truck = new THREE.Group();
  const L = TRUCK_LENGTH;
  const W = TRUCK_WIDTH;

  const body = mat(PALETTE[colorIndex % PALETTE.length], 0.45, 0.25);
  const panel = mat(0xe8e9e6, 0.7);
  const dark = mat(0x24262a, 0.8);

  // Chassis rails.
  for (const z of [-0.75, 0.75]) {
    truck.add(box(L * 0.9, 0.2, 0.14, dark, -0.4, 0.72, z));
  }

  // Day cab, nose at the front (+X).
  const cab = cabAssembly(colorIndex, { sleeper: false, stack: false });
  cab.group.position.x = L / 2 - 1.05;
  truck.add(cab.group);

  // Box body with ribs and a livery band.
  const boxLen = 4.3;
  const boxX = -(L / 2) + boxLen / 2 + 0.25;
  truck.add(box(boxLen, 2.7, W, panel, boxX, 2.25, 0));
  const ribGeometry = new THREE.BoxGeometry(0.09, 2.6, W + 0.04);
  const ribMaterial = mat(0xd2d5d1, 0.75);
  for (let r = 0; r < 6; r++) {
    const rx = boxX - boxLen / 2 + 0.5 + r * ((boxLen - 1) / 5);
    const rib = new THREE.Mesh(ribGeometry, ribMaterial);
    rib.position.set(rx, 2.25, 0);
    rib.castShadow = true;
    rib.receiveShadow = true;
    truck.add(rib);
  }
  truck.add(box(boxLen, 0.42, W + 0.06, body, boxX, 1.28, 0));

  // Rear doors + tail lamps.
  truck.add(box(0.14, 2.5, W - 0.1, mat(0xcfd2ce, 0.7), boxX - boxLen / 2 - 0.05, 2.25, 0));
  const red = new THREE.MeshStandardMaterial({ color: 0xd63b2a, emissive: 0x8e1c12, emissiveIntensity: 0.6, roughness: 0.4 });
  const tailGeometry = new THREE.BoxGeometry(0.1, 0.3, 0.45);
  for (const sgn of [-1, 1]) {
    const tail = new THREE.Mesh(tailGeometry, red);
    tail.position.set(boxX - boxLen / 2 - 0.1, 1.05, sgn * 0.85);
    tail.castShadow = true;
    truck.add(tail);
  }

  // Mudflaps behind the rear axle pair.
  const flapGeometry = new THREE.BoxGeometry(0.06, 0.5, 0.6);
  const flapMaterial = mat(0x1a1c1f, 0.95);
  for (const sgn of [-1, 1]) {
    const flap = new THREE.Mesh(flapGeometry, flapMaterial);
    flap.position.set(-L / 2 + 0.35, 0.34, sgn * 0.95);
    flap.castShadow = true;
    truck.add(flap);
  }

  // Wheels: front steer axle + rear tandem.
  wheelSet(truck, { xs: [L / 2 - 1.05, -1.55, -2.75], halfW: W / 2 - 0.12, radius: WHEEL_RADIUS, width: 0.38 });

  truck.userData.length = L;
  return truck;
}

export const TRUCK_DIMENSIONS = { length: TRUCK_LENGTH, width: TRUCK_WIDTH };
