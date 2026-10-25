// Pointer tracking + smoothed gaze. The eyes aim at a world-space target
// (three-vrm lookAt); head/neck carry the visible deflection and it decays back
// to centre after the pointer rests.
import * as THREE from "three";

export interface GazeDriver {
  gazeTarget: THREE.Object3D;
  update(dt: number, now: number): void;
  // smoothed gaze direction, -1..1 on both axes (0,0 = straight ahead)
  readonly gaze: { x: number; y: number };
  dispose(): void;
}

/**
 * Map a pointer position to a gaze direction, -1..1 on both axes.
 *
 * The avatar sits at the far left of the window, so "pointer over the avatar"
 * is neutral and full deflection is reached at each window edge. The two
 * horizontal (and vertical) sides need *separate* spans: with one half-window
 * span centred on the avatar, the left edge only reached ≈ -0.24 while the
 * right edge saturated at +1, so the head sat pinned looking right and moving
 * the mouse left hardly moved it — which reads as the gaze being reversed.
 *
 * `bb` is the avatar's client rect; `vw`/`vh` the window size.
 */
export function pointerToGaze(
  clientX: number,
  clientY: number,
  bb: { left: number; top: number; width: number; height: number },
  vw: number,
  vh: number,
): { x: number; y: number } {
  const cx = bb.left + bb.width / 2;
  const cy = bb.top + bb.height / 2;
  const MIN_SPAN = 60; // never divide by ~0 when the avatar hugs an edge
  const spanLeft = Math.max(cx, MIN_SPAN);
  const spanRight = Math.max(vw - cx, MIN_SPAN);
  const spanUp = Math.max(cy, MIN_SPAN);
  const spanDown = Math.max(vh - cy, MIN_SPAN);
  return {
    x: THREE.MathUtils.clamp((clientX - cx) / (clientX < cx ? spanLeft : spanRight), -1, 1),
    y: THREE.MathUtils.clamp((clientY - cy) / (clientY < cy ? spanUp : spanDown), -1, 1),
  };
}

export function createGazeDriver(mount: HTMLElement, scene: THREE.Scene): GazeDriver {
  // World-space point the eyes aim at; moved toward the cursor every frame.
  // `lookAt` is driven by three-vrm, head/neck rotation is layered on top
  // (eye-only deflection on this rig is ~5°, invisible in a small panel).
  const gazeTarget = new THREE.Object3D();
  gazeTarget.position.set(0, 1.42, 1.4);
  scene.add(gazeTarget);

  const pointer = { x: 0, y: 0, lastMove: 0 };
  // smoothed gaze direction, -1..1 on both axes (0,0 = straight ahead)
  const gaze = { x: 0, y: 0 };
  const onPointerMove = (ev: PointerEvent): void => {
    const r = mount.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const g = pointerToGaze(ev.clientX, ev.clientY, r, window.innerWidth, window.innerHeight);
    pointer.x = g.x;
    pointer.y = g.y;
    pointer.lastMove = performance.now();
  };
  window.addEventListener("pointermove", onPointerMove);

  return {
    gazeTarget,
    gaze,
    update(dt: number, now: number): void {
      // gaze: eyes aim at the pointer (three-vrm lookAt), head/neck carry the
      // visible deflection; decays back to centre after the pointer rests.
      // Eye-only deflection on this rig is ~5° even at extreme angles, so the
      // target is pushed far out (steep gaze angle) and the head does the rest.
      const idle = now - pointer.lastMove > 3500;
      gaze.x += ((idle ? 0 : pointer.x) - gaze.x) * Math.min(1, dt * 6);
      gaze.y += ((idle ? 0 : pointer.y) - gaze.y) * Math.min(1, dt * 6);
      gazeTarget.position.set(gaze.x * 3, 1.43 - gaze.y * 1.6, 1.4);
    },
    dispose(): void {
      window.removeEventListener("pointermove", onPointerMove);
    },
  };
}

// Sign check (measured on this rig, which is yawed π by rotateVRM0): local
// +rotation.y turns the face toward screen-right, and +rotation.x tips it up.
// gaze.x/y are +1 at screen-right / screen-bottom, so yaw keeps its sign and
// pitch is negated.
export function applyHeadGaze(
  gaze: { x: number; y: number },
  headBone: THREE.Object3D | null,
  neckBone: THREE.Object3D | null,
): void {
  if (headBone) {
    headBone.rotation.y = gaze.x * 0.36;
    headBone.rotation.x = -gaze.y * 0.2;
  }
  if (neckBone) {
    neckBone.rotation.y = gaze.x * 0.16;
    neckBone.rotation.x = -gaze.y * 0.09;
  }
}
