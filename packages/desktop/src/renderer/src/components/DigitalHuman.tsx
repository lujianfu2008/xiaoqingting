// 3D 数字人（VRM）— 侧栏形象位（比蜻蜓位更高，容纳半身像）。
// 常驻呼吸 + 随机眨眼；回复情绪标记映射到 VRM 表情；
// 朗读时用实时音频分析驱动口型（真对口型）；
// 视线 + 头颈跟随鼠标（眼神跟随）。
// 收起/切换形象时组件卸载，three 资源全部释放。
//
// Scene plumbing lives in ./digitalhuman/{stage,avatar,gaze,face}.ts; this file
// only owns the component lifecycle.
import { useEffect, useRef, useState } from "react";
import { VRMUtils, type VRM } from "@pixiv/three-vrm";
import { useStore } from "../store";
import { useT } from "../i18n";
import avatarUrl from "../assets/avatar.vrm?url";
import { createStage } from "./digitalhuman/stage";
import { loadAvatar, type AvatarRig } from "./digitalhuman/avatar";
import { applyHeadGaze, createGazeDriver } from "./digitalhuman/gaze";
import { FaceDriver } from "./digitalhuman/face";

export function DigitalHuman(): React.JSX.Element {
  const t = useT();
  const mountRef = useRef<HTMLDivElement>(null);
  const expr = useStore((s) => s.expr);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");

  // latest expr for the rAF loop without re-initializing three
  const liveRef = useRef({ expr });
  liveRef.current = { expr };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const stage = createStage(mount);
    const stageScene = stage.scene;
    const gazer = createGazeDriver(mount, stageScene);
    let disposed = false;

    let vrm: VRM | null = null;
    let rig: AvatarRig | null = null;
    let face: FaceDriver | null = null;
    loadAvatar({
      url: avatarUrl,
      scene: stageScene,
      gazeTarget: gazer.gazeTarget,
      isDisposed: () => disposed,
      onReady: (r) => {
        rig = r;
        vrm = r.vrm;
        face = new FaceDriver(r.vrm);
        setStatus("ready");
      },
      onError: () => setStatus("failed"),
    });

    let raf = 0;
    let last = performance.now();

    const tick = (): void => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      if (!vrm || !rig) {
        stage.render();
        return;
      }
      const t = now / 1000;
      face?.update(dt, liveRef.current.expr);

      gazer.update(dt, now);
      applyHeadGaze(gazer.gaze, rig.headBone, rig.neckBone);

      // breathing + gentle sway
      vrm.scene.position.y = Math.sin(t * 1.4) * 0.006;
      vrm.scene.rotation.y = rig.baseYaw + Math.sin(t * 0.4) * 0.05;

      vrm.update(dt);
      stage.render();
    };
    raf = requestAnimationFrame(tick);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      gazer.dispose();
      if (vrm) {
        VRMUtils.deepDispose(vrm.scene);
        stageScene.remove(vrm.scene);
      }
      stage.dispose();
    };
  }, []);

  return (
    <div className="dh-stage" ref={mountRef}>
      {status !== "ready" && (
        <div className={`dh-status ${status}`}>
          {status === "loading" ? t("av.dhLoading") : t("av.dhFail")}
        </div>
      )}
    </div>
  );
}
