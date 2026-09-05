import * as THREE from 'three';
import type { PixelRect } from '../overlay/coords';

/** Fixed render aspect: bays.json and the stub constants assume 16:9. */
const TARGET_ASPECT = 16 / 9;

/** Contain-fits a 16:9 rect inside a w×h area (centered letterbox). */
function fitContain(width: number, height: number): PixelRect {
  if (width / height > TARGET_ASPECT) {
    const fittedW = height * TARGET_ASPECT;
    return { x: (width - fittedW) / 2, y: 0, w: fittedW, h: height };
  }
  const fittedH = width / TARGET_ASPECT;
  return { x: 0, y: (height - fittedH) / 2, w: width, h: fittedH };
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

/** Creates the renderer, camera, lights, and resize handling for the lot. */
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
  scene.background = new THREE.Color(0x8ec5e8);
  scene.fog = new THREE.Fog(0x8ec5e8, 90, 160);

  // Fixed 16:9 projection: never derives from the window aspect, so capture
  // (960×540), bays.json, and stub-detector constants stay aligned at any
  // window size.
  const camera = new THREE.PerspectiveCamera(55, TARGET_ASPECT, 0.1, 400);
  camera.position.set(-22, 24, 30);
  camera.lookAt(0, 0, -2);

  const hemisphere = new THREE.HemisphereLight(0xcfe8ff, 0x51603f, 0.9);
  scene.add(hemisphere);

  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(30, 45, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -70;
  sun.shadow.camera.right = 70;
  sun.shadow.camera.top = 50;
  sun.shadow.camera.bottom = -50;
  sun.shadow.camera.far = 120;
  scene.add(sun);

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
  window.addEventListener('resize', onResize);

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
      window.removeEventListener('resize', onResize);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}