import * as THREE from 'three';
import type { PixelRect } from '../overlay/coords';

/** Fixed render aspect: bays.json and the stub constants assume 16:9. */
const TARGET_ASPECT = 16 / 9;

/**
 * Approved camera framing (depot yard): head-on to the dock wall, orbit form
 * theta 0.02, phi 0.40, radius 45 about (0, 2.2, -7) — bead
 * parking-bay-detection-xbw. Position derives from the orbit, so the framing
 * stays reviewable against the mockup's frameCamera().
 */
const CAM_THETA = 0.02;
const CAM_PHI = 0.4;
const CAM_RADIUS = 45;
const CAM_TARGET = new THREE.Vector3(0, 2.2, -7);

// Gradient sky dome (from the approved mockup): zenith 0x4f8fd0, horizon
// 0xcfe4f2, below-horizon 0x9fb6a8. Replaces scene.background so the fog
// color blends into the horizon instead of a flat fill.
const SKY_TOP = 0x4f8fd0;
const SKY_HORIZON = 0xcfe4f2;
const SKY_LOW = 0x9fb6a8;
const SKY_RADIUS = 400;

const SKY_VERTEX = /* glsl */ `
varying vec3 vPos;
void main() {
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FRAGMENT = /* glsl */ `
varying vec3 vPos;
uniform vec3 top;
uniform vec3 horizon;
uniform vec3 lowc;
void main() {
  float h = normalize(vPos).y;
  vec3 c = mix(horizon, top, clamp(h * 1.6, 0.0, 1.0));
  c = mix(lowc, c, clamp((h + 0.12) * 6.0, 0.0, 1.0));
  gl_FragColor = vec4(c, 1.0);
}`;

function createSkyDome(): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.SphereGeometry(SKY_RADIUS, 32, 20),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        top: { value: new THREE.Color(SKY_TOP) },
        horizon: { value: new THREE.Color(SKY_HORIZON) },
        lowc: { value: new THREE.Color(SKY_LOW) },
      },
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
    }),
  );
}

/** Retuned day light rig from the approved mockup (sun + sky fill + bounce). */
function createLights(): THREE.Group {
  const lights = new THREE.Group();

  const hemisphere = new THREE.HemisphereLight(0xcfe8ff, 0x5c6a4a, 0.75);
  lights.add(hemisphere);

  const sun = new THREE.DirectionalLight(0xfff4e0, 2.1);
  sun.position.set(42, 58, 26);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -70;
  sun.shadow.camera.right = 70;
  sun.shadow.camera.top = 60;
  sun.shadow.camera.bottom = -60;
  sun.shadow.camera.far = 220;
  sun.shadow.bias = -0.0006;
  lights.add(sun);

  const fill = new THREE.DirectionalLight(0xbcd6ff, 0.35);
  fill.position.set(-30, 24, -40);
  lights.add(fill);

  return lights;
}

export interface World {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  /** The WebGL canvas; used as the capture source by the frame pipeline. */
  readonly domElement: HTMLCanvasElement;
  /**
   * The 16:9 contain-fit rect of the WebGL canvas inside the container, in
   * CSS pixels (top-left origin). Normalized wire/bay coordinates map into
   * THIS rect on the overlay — not the full container — so boxes and bays
   * stay aligned at any window aspect. Mutated in place on resize.
   */
  readonly viewport: PixelRect;
  render(): void;
  dispose(): void;
}

/** Creates the renderer, camera, sky, lights, and resize handling for the lot. */
export function createWorld(container: HTMLElement): World {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const initialRect = fitContain(container.clientWidth, container.clientHeight);
  renderer.setSize(initialRect.w, initialRect.h);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoftShadowMap deprecated in three 0.18x
  // The canvas is the fitted 16:9 rect, centered inside the container; the
  // remaining letterbox area shows the container background.
  renderer.domElement.style.position = 'absolute';
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // Fog tuned to the sky horizon: distant hills and treeline dissolve into
  // the horizon band instead of a flat background color.
  scene.fog = new THREE.Fog(SKY_HORIZON, 90, 260);
  scene.add(createSkyDome());
  scene.add(createLights());

  // Fixed 16:9 projection: never derives from the window aspect, so capture
  // (960×540), bays.json, and stub-detector constants stay aligned at any
  // window size. Near/far follow the mockup camera (0.5/700 — the far plane
  // must contain the sky dome).
  const camera = new THREE.PerspectiveCamera(55, TARGET_ASPECT, 0.5, 700);
  camera.position.set(
    CAM_TARGET.x + CAM_RADIUS * Math.cos(CAM_PHI) * Math.sin(CAM_THETA),
    CAM_TARGET.y + CAM_RADIUS * Math.sin(CAM_PHI),
    CAM_TARGET.z + CAM_RADIUS * Math.cos(CAM_PHI) * Math.cos(CAM_THETA),
  );
  camera.lookAt(CAM_TARGET);

  let currentRect: PixelRect = initialRect;

  const applyRect = (): void => {
    renderer.setSize(currentRect.w, currentRect.h);
    renderer.domElement.style.left = `${currentRect.x}px`;
    renderer.domElement.style.top = `${currentRect.y}px`;
  };

  const onResize = (): void => {
    currentRect = fitContain(container.clientWidth, container.clientHeight);
    camera.aspect = TARGET_ASPECT;
    camera.updateProjectionMatrix();
    applyRect();
  };
  applyRect();
  // Observe the container (the viewport panel), not the window: the shell can
  // resize the panel independently of the window (layout changes, mobile
  // stacking), and the 16:9 contain-fit letterbox must track the panel only.
  const observer = new ResizeObserver(onResize);
  observer.observe(container);

  return {
    scene,
    camera,
    domElement: renderer.domElement,
    get viewport(): PixelRect {
      return currentRect;
    },
    render(): void {
      renderer.render(scene, camera);
    },
    dispose(): void {
      observer.disconnect();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

/** Contain-fits a 16:9 rect inside a w×h area (centered letterbox). */
function fitContain(width: number, height: number): PixelRect {
  if (width / height > TARGET_ASPECT) {
    const fittedW = height * TARGET_ASPECT;
    return { x: (width - fittedW) / 2, y: 0, w: fittedW, h: height };
  }
  const fittedH = width / TARGET_ASPECT;
  return { x: 0, y: (height - fittedH) / 2, w: width, h: height };
}
