// three.js scene plumbing for the sidebar avatar: camera, renderer, lights and
// the resize observer that keeps the canvas matched to its container.
import * as THREE from "three";

export interface AvatarStage {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  render(): void;
  dispose(): void;
}

export function createStage(mount: HTMLElement): AvatarStage {
  const scene = new THREE.Scene();
  // Bust framing: chin ~1.30, crown ~1.645, chest ~1.10 in this model's world units.
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 20);
  camera.position.set(0, 1.36, 1.32);
  camera.lookAt(0, 1.36, 0);

  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  mount.appendChild(renderer.domElement);

  const resize = (): void => {
    const w = mount.clientWidth || 220;
    const h = mount.clientHeight || 130;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(mount);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x2a3f55, 2.2));
  const key = new THREE.DirectionalLight(0xbfe6ff, 2.2);
  key.position.set(1, 2, 1.6);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x7fd8ff, 1.2);
  rim.position.set(-1.5, 1.5, -1);
  scene.add(rim);

  return {
    scene,
    camera,
    renderer,
    render: () => renderer.render(scene, camera),
    dispose: () => {
      ro.disconnect();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
