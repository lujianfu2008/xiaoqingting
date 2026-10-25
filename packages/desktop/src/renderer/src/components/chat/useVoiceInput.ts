import { useEffect, useRef, useState } from "react";
import { useStore } from "../../store";
import { createWavRecorder, transcribeLocal } from "../../voiceRecorder";
import { t } from "../../i18n";

interface VoiceInput {
  recording: boolean;
  voiceMsg: string | null;
  toggleRecording: () => void;
  clearVoiceMsg: () => void;
}

/**
 * Microphone capture + offline transcription.
 *
 * Space-to-talk is wired here: hold Space to record, release to transcribe and
 * (per the user's asrAutoSend setting) send. Space NEVER triggers voice while
 * an input/textarea/contentEditable is focused — typing always comes first.
 */
export function useVoiceInput(
  currentSessionId: string | null,
  appendDraft: (text: string) => void,
): VoiceInput {
  const recording = useStore((s) => s.recording);
  const setRecording = useStore((s) => s.setRecording);
  const send = useStore((s) => s.send);

  const [voiceMsg, setVoiceMsg] = useState<string | null>(null);
  const recorderRef = useRef<ReturnType<typeof createWavRecorder> | null>(null);

  const startRec = async (): Promise<void> => {
    if (recording) return;
    try {
      const rec = createWavRecorder();
      await rec.start();
      recorderRef.current = rec;
      setVoiceMsg(null);
      setRecording(true);
    } catch {
      setVoiceMsg(t("vm.micDenied"));
    }
  };

  const finishRec = async (fromShortcut: boolean): Promise<void> => {
    if (!recording) return;
    setRecording(false);
    const rec = recorderRef.current;
    recorderRef.current = null;
    setVoiceMsg(t("vm.recognizing"));
    try {
      const pcm = await rec?.stop();
      if (!pcm || pcm.byteLength < 4000) {
        setVoiceMsg(t("vm.silence"));
        return;
      }
      const text = await transcribeLocal(pcm);
      setVoiceMsg(null);
      if (!text) {
        setVoiceMsg(t("vm.noContent"));
        return;
      }
      // Shortcut flow respects the user's auto-send setting; the mic button
      // always fills the input box for editing.
      const autoSend = fromShortcut && useStore.getState().voiceSettings.asrAutoSend;
      if (!autoSend) {
        appendDraft(text);
        if (fromShortcut) setVoiceMsg(t("vm.toDraft"));
        return;
      }
      const state = useStore.getState();
      const isBusy = currentSessionId ? (state.busy[currentSessionId] ?? false) : false;
      if (isBusy) {
        appendDraft(text);
        setVoiceMsg(t("vm.busyDraft"));
      } else {
        send(text);
      }
    } catch (e) {
      setVoiceMsg(e instanceof Error ? e.message : t("vm.fail"));
    }
  };

  const toggleRecording = (): void => {
    if (recording) void finishRec(false);
    else void startRec();
  };

  // Hold Space to talk, release to transcribe + send.
  // Press Esc (or click the chat area) to leave the input box, then hold Space.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.code !== "Space" || e.repeat) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "SELECT" || tag === "BUTTON") return;
      if (t && (t.isContentEditable || tag === "INPUT" || tag === "TEXTAREA")) return;
      e.preventDefault();
      void startRec();
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code !== "Space" || !recording) return;
      e.preventDefault();
      void finishRec(true);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  });

  return {
    recording,
    voiceMsg,
    toggleRecording,
    clearVoiceMsg: () => setVoiceMsg(null),
  };
}
