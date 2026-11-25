import type { BlmState, GetState, SetState } from "../types";
import { stopAudio, playSpoken } from "../../speech";
import { LS } from "../persist";
import { setSendRetries } from "../socket";

let exprTimer: ReturnType<typeof setTimeout> | null = null;

export function createVoiceActions(
  set: SetState,
  get: GetState,
): Pick<
  BlmState,
  | "setAutoRead"
  | "setNotifyEnabled"
  | "setSendRetryCount"
  | "updateVoiceSettings"
  | "setWakeError"
  | "setContinuousVoice"
  | "speak"
  | "stopSpeaking"
  | "setExpr"
  | "setAvatarMode"
  | "setAvatarVisible"
> {
  return {
    setAutoRead(on) {
      set({ autoRead: on });
      localStorage.setItem(LS.autoRead, on ? "1" : "0");
      if (!on) {
        stopAudio();
        set({ speaking: false });
      }
    },

    setNotifyEnabled(on) {
      set({ notifyEnabled: on });
      localStorage.setItem(LS.notifyEnabled, on ? "1" : "0");
    },

    setSendRetryCount(n) {
      const v = Math.max(0, Math.min(5, Math.trunc(n)));
      set({ sendRetryCount: v });
      localStorage.setItem(LS.sendRetryCount, String(v));
      // socket.ts 的重发预算读的是模块级变量，改设置即时生效（在途消息以
      // 记账时的预算结算，改完不影响已发那条）。
      setSendRetries(v);
    },

    updateVoiceSettings(patch) {
      set((s) => {
        const voiceSettings = { ...s.voiceSettings, ...patch };
        localStorage.setItem(LS.voiceSettings, JSON.stringify(voiceSettings));
        return { voiceSettings };
      });
    },
    setWakeError(msg) {
      set({ wakeError: msg });
    },
    setContinuousVoice(on) {
      set({ continuousVoice: on });
    },

    speak(text, opts) {
      const t = text.trim();
      if (!t) return;
      const vs = get().voiceSettings;
      set({ speaking: true });
      void playSpoken(t, {
        voice: opts?.voice ?? vs.ttsVoice,
        rate: opts?.rate ?? vs.ttsRate,
        volume: opts?.volume ?? vs.ttsVolume,
      }).then((r) => {
        // Only clear if this utterance is still the current one (a newer speak()
        // may already have replaced it).
        if (r.error === "cancelled") return;
        if (get().speaking) set({ speaking: false });
      });
    },

    stopSpeaking() {
      stopAudio();
      set({ speaking: false });
    },

    setExpr(expr, holdMs = 2600) {
      set({ expr });
      if (exprTimer) clearTimeout(exprTimer);
      if (expr !== "normal") {
        exprTimer = setTimeout(() => set({ expr: "normal" }), holdMs);
      }
    },

    setAvatarMode(mode) {
      set({ avatarMode: mode });
      localStorage.setItem(LS.avatarMode, mode);
    },

    setAvatarVisible(on) {
      set({ avatarVisible: on });
      localStorage.setItem(LS.avatarVisible, on ? "1" : "0");
    },
  };
}
