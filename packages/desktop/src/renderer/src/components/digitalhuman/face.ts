// Per-frame face driver: emotion → VRM expression presets, random blink, real
// lip-sync sampled from the TTS audio, plus the curiosity head tilt.
import * as THREE from "three";
import { type VRM } from "@pixiv/three-vrm";
import { readLipSync } from "../../speech";

// Different model generations name presets differently (VRM0 fun/sorrow …).
function resolve(vrm: VRM, names: string[]): string | null {
  for (const n of names) if (vrm.expressionManager?.getExpression(n)) return n;
  return null;
}

export class FaceDriver {
  // Smoothly-blended expression values keyed by resolved expression name.
  private smooth: Record<string, number> = {};
  private nextBlink = 1.5;
  private blinkT = -1;

  constructor(private vrm: VRM) {}

  update(dt: number, expr: string): void {
    const em = this.vrm.expressionManager;
    if (!em) return;
    const resolveName = (names: string[]): string | null => resolve(this.vrm, names);

    const set = (name: string | null, target: number, rate = 8): void => {
      if (!name) return;
      const cur = this.smooth[name] ?? 0;
      const v = cur + (target - cur) * Math.min(1, dt * rate);
      this.smooth[name] = v;
      em.setValue(name, v);
    };

    const happy = resolveName(["happy", "joy", "fun"]);
    const sad = resolveName(["sad", "sorrow"]);
    const surprised = resolveName(["Surprised", "surprised"]); // VRM0 sample uses a capital S
    const relaxed = resolveName(["relaxed"]);
    const angry = resolveName(["angry"]);
    for (const n of [happy, sad, surprised, relaxed, angry]) set(n, 0);

    let tilt = 0;
    switch (expr) {
      case "happy":
        set(happy, 1);
        break;
      case "sad":
        set(sad, 1);
        break;
      case "surprised":
        set(surprised, 1);
        break;
      case "curious":
        set(relaxed ?? happy, 0.35);
        tilt = 0.1;
        break;
      case "serious":
        set(angry, 0.3); // slight frown — reads as concentration
        break;
      default:
        break;
    }

    // random blink
    this.nextBlink -= dt;
    if (this.nextBlink <= 0 && this.blinkT < 0) {
      this.blinkT = 0;
      this.nextBlink = 2 + Math.random() * 3.5;
    }
    let blink = 0;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const d = 0.16;
      blink = this.blinkT < d / 2 ? this.blinkT / (d / 2) : Math.max(0, 1 - (this.blinkT - d / 2) / (d / 2));
      if (this.blinkT >= d) this.blinkT = -1;
    }
    set(resolveName(["blink"]), blink, 30);

    // real lip-sync: viseme weights sampled from the TTS audio
    const lip = readLipSync();
    set(resolveName(["aa", "a"]), lip.aa, 30);
    set(resolveName(["ih"]), lip.ih, 30);
    set(resolveName(["ou", "u"]), lip.ou, 30);
    set(resolveName(["ee", "e"]), lip.ee, 30);
    set(resolveName(["oh", "o"]), lip.oh, 30);

    // curiosity head tilt
    this.vrm.scene.rotation.z = THREE.MathUtils.lerp(this.vrm.scene.rotation.z, tilt, dt * 5);
  }
}
