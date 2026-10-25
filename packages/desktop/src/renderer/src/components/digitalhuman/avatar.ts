// Loads the VRM model and wires the rig: normalizes it, relaxes the T-pose arms
// and exposes the head/neck bones the gaze driver rotates.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";

export interface AvatarRig {
  vrm: VRM;
  // rotateVRM0() yaws VRM0 models by π; the sway must add to this base yaw
  // instead of overwriting it, or the model ends up facing away.
  baseYaw: number;
  headBone: THREE.Object3D | null;
  neckBone: THREE.Object3D | null;
}

export function loadAvatar(opts: {
  url: string;
  scene: THREE.Scene;
  gazeTarget: THREE.Object3D;
  isDisposed: () => boolean;
  onReady: (rig: AvatarRig) => void;
  onError: (err: unknown) => void;
}): void {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  loader.load(
    opts.url,
    (gltf) => {
      if (opts.isDisposed()) return;
      const vrm = gltf.userData.vrm as VRM;
      VRMUtils.removeUnnecessaryJoints(vrm.scene);
      VRMUtils.rotateVRM0(vrm); // VRM0 faces +Z; VRM1 is a no-op
      const baseYaw = vrm.scene.rotation.y;
      // VRM0 sample models ship in T-pose. +Z on the left arm (and -Z on the
      // right) swings it down to the side; the opposite sign raises it.
      const arms: [string, number][] = [
        ["leftUpperArm", 1.15],
        ["rightUpperArm", -1.15],
        ["leftLowerArm", 0.18],
        ["rightLowerArm", -0.18],
      ];
      for (const [name, z] of arms) {
        const bone = vrm.humanoid.getNormalizedBoneNode(name as never);
        if (bone) bone.rotation.z = z;
      }
      // Eyes follow the gaze target; head/neck add the visible part.
      if (vrm.lookAt) {
        vrm.lookAt.target = opts.gazeTarget;
        vrm.lookAt.autoUpdate = true;
      }
      const headBone = vrm.humanoid.getNormalizedBoneNode("head" as never) ?? null;
      const neckBone = vrm.humanoid.getNormalizedBoneNode("neck" as never) ?? null;
      opts.scene.add(vrm.scene);
      opts.onReady({ vrm, baseYaw, headBone, neckBone });
    },
    undefined,
    (err) => {
      console.error("[digital-human] VRM load failed:", err);
      opts.onError(err);
    },
  );
}
