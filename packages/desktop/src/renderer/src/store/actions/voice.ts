import type { BlmState, GetState, SetState } from "../types";
import { stopAudio, playSpoken } from "../../speech";
import { LS } from "../persist";

let exprTimer: ReturnType<typeof setTimeout> | null = null;

export function createVoiceActions(
  set: SetState,
  get: GetState,
): Pick<
  BlmState,
  | "setAutoRead"
  | "updateVoiceSettings"
  | "speak"
  | "stopSpeaking"
  | "setExpr"
  | "setAvatarMode"
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

    updateVoiceSettings(patch) {
      set((s) => {
        const voiceSettings = { ...s.voiceSettings, ...patch };
        localStorage.setItem(LS.voiceSettings, JSON.stringify(voiceSettings));
        return { voiceSettings };
      });
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
  };
}
