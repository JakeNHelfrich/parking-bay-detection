import * as THREE from 'three';

export interface World {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  /** The WebGL canvas; used as the capture source by the frame pipeline. */
  readonly domElement: HTMLCanvasElement;
  render(): void;
  dispose(): void;
}

/** Creates the renderer, camera, lights, and resize handling for the lot. */
export function createWorld(container: HTMLElement): World {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoftShadowMap deprecated in three 0.18x
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8ec5e8);
  scene.fog = new THREE.Fog(0x8ec5e8, 90, 160);

  const camera = new THREE.PerspectiveCamera(
    55,
    container.clientWidth / container.clientHeight,
    0.1,
    400,
  );
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

  const onResize = (): void => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };
  window.addEventListener('resize', onResize);

  return {
    scene,
    camera,
    domElement: renderer.domElement,
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