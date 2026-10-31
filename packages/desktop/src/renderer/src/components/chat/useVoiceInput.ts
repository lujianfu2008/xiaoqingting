import { useEffect, useRef, useState } from "react";
import { useStore } from "../../store";
import { createWavRecorder, transcribeLocal } from "../../voiceRecorder";
import { t } from "../../i18n";

interface VoiceInput {
  recording: boolean;
  voiceMsg: string | null;
  toggleRecording: () => void;
  clearVoiceMsg: () => void;
  /** 语音唤醒入口：开始一段"说完静音自动停"的录音（区别于按住空格）。 */
  startVoiceCommand: () => void;
}

// 唤醒录音的自动停：检测到说话后静音这么久就结束；总长兜底防挂麦。
const WAKE_SILENCE_MS = 1600;
const WAKE_MAX_MS = 15000;
/** 高于该 RMS 视为在说话（唤醒录音的语音检测阈值）。 */
const RMS_SPEECH = 0.02;

// 句尾标点启发式：问句（语气词结尾 / 疑问词开头）→ ？，其余 → 。识别结果
// 偶尔自带标点就不重复加。停顿处的逗号由分段识别给出（main/asr.ts）。
const TAIL_QUESTION_RE =
  /(吗|嘛|呢|么)$|^(什么|怎么|怎么样|为什么|哪|谁|几|多少|如何|是不是|能不能|有没有|要不要|会不会|可不可以)/;
function withTailPunct(s: string): string {
  if (!s || /[。．.?？!！，,；;：:]$/.test(s)) return s;
  return s + (TAIL_QUESTION_RE.test(s) ? "？" : "。");
}

/**
 * Microphone capture + offline transcription.
 *
 * Space-to-talk is wired here: hold Space to record, release to transcribe and
 * (per the user's asrAutoSend setting) send. Space NEVER triggers voice while
 * an input/textarea/contentEditable is focused — typing always comes first.
 * Voice wake (useWakeWord → "blm-wake" event) enters the same flow via
 * startVoiceCommand(), but stops itself after a pause instead of a key release.
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
  // 唤醒录音的自动停状态（仅唤醒触发时非 null）。
  const autoStopRef = useRef<{
    startedAt: number;
    speechSeen: boolean;
    lastVoice: number;
  } | null>(null);
  const autoStopTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // getUserMedia 打开中的标记：续听/连喊可能在 recording 置位前重入，防止双开麦。
  const startingRef = useRef(false);
  // 本次录音的停顿切分位（startRec 里重建）：识别时按点分段出逗号。
  const pausesRef = useRef<number[]>([]);

  const clearAutoStop = (): void => {
    if (autoStopTimerRef.current) {
      clearInterval(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
    autoStopRef.current = null;
  };

  const startRec = async (opts?: {
    onLevel?: (rms: number) => void;
    wake?: boolean;
  }): Promise<boolean> => {
    if (useStore.getState().recording || startingRef.current) return false;
    startingRef.current = true;
    // 每次录音新建停顿数组传给录音器（按引用填充），finish 时随 PCM 送识别。
    const pauses: number[] = [];
    pausesRef.current = pauses;
    try {
      const rec = createWavRecorder({ onLevel: opts?.onLevel, pauses });
      await rec.start();
      recorderRef.current = rec;
      setVoiceMsg(null);
      setRecording(true);
      useStore.setState({ recWake: opts?.wake === true });
      return true;
    } catch {
      setVoiceMsg(t("vm.micDenied"));
      return false;
    } finally {
      startingRef.current = false;
    }
  };

  const finishRec = async (fromShortcut: boolean): Promise<void> => {
    if (!useStore.getState().recording) return;
    // 在 clearAutoStop 清掉状态前先取：唤醒录音要靠它们决定跳过/续听。
    const wasWake = useStore.getState().recWake;
    const sawSpeech = autoStopRef.current?.speechSeen === true;
    clearAutoStop();
    setRecording(false);
    useStore.setState({ recWake: false });
    const rec = recorderRef.current;
    recorderRef.current = null;
    setVoiceMsg(t("vm.recognizing"));
    try {
      const pcm = await rec?.stop();
      if (!pcm || pcm.byteLength < 4000) {
        // 唤醒路径静默收场（不留「识别中…」）；空格路径保留原有提示。
        setVoiceMsg(wasWake ? null : t("vm.silence"));
        return;
      }
      // 唤醒/连续录音没检出语音就静默跳过：不浪费识别，更避免把底噪幻听成
      // 文字发出去（连续模式的空闲续听循环会反复走到这里）。
      if (wasWake && !sawSpeech) {
        setVoiceMsg(null);
        return;
      }
      // 停顿切分位随 PCM 一起送识别：说话停顿处会得到逗号。
      const text = withTailPunct(await transcribeLocal(pcm, pausesRef.current));
      setVoiceMsg(null);
      if (!text) {
        setVoiceMsg(t("vm.noContent"));
        return;
      }
      // 说了一句真话（有语音、有内容）：通知唤醒编排给连续对话计时续期。
      if (wasWake) window.dispatchEvent(new CustomEvent("blm-voice-utterance"));
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
    if (recording) {
      // ⏹ 手动停 = 连续对话的逃生口：退出连续模式，回到待唤醒。
      if (useStore.getState().continuousVoice) {
        useStore.getState().setContinuousVoice(false);
      }
      void finishRec(false);
    } else void startRec();
  };

  // 语音唤醒入口：开始录音 + 挂静音自动停。说完停顿 ~1.6s 自动按
  // asrAutoSend 发送（等价于"松开空格"），15 秒封顶防挂麦。
  const startVoiceCommand = (): void => {
    void startRec({
      wake: true,
      onLevel: (rms) => {
        const st = autoStopRef.current;
        if (!st) return;
        if (rms >= RMS_SPEECH) {
          st.speechSeen = true;
          st.lastVoice = Date.now();
        }
      },
    }).then((ok) => {
      if (!ok) {
        // 麦克风拿不到（被占用/被拒）：连续模式别再空转重试，直接退出。
        if (useStore.getState().continuousVoice) {
          useStore.getState().setContinuousVoice(false);
        }
        return;
      }
      autoStopRef.current = { startedAt: Date.now(), speechSeen: false, lastVoice: 0 };
      setVoiceMsg(t("vm.wakeRecording"));
      autoStopTimerRef.current = setInterval(() => {
        const st = autoStopRef.current;
        if (!st) return;
        const now = Date.now();
        if (
          (st.speechSeen && now - st.lastVoice > WAKE_SILENCE_MS) ||
          now - st.startedAt > WAKE_MAX_MS
        ) {
          void finishRec(true);
        }
      }, 200);
    });
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

  // 语音唤醒命中（useWakeWord 派发）→ 直接进入语音输入。无依赖数组：
  // 每次渲染重挂，闭包始终新鲜（与上面空格监听同一套路）。
  useEffect(() => {
    const onWake = (): void => startVoiceCommand();
    // 连续对话续听（useWakeWord 在门开且未超时时派发）→ 开下一段录音。
    const onContinue = (): void => {
      if (useStore.getState().continuousVoice) startVoiceCommand();
    };
    window.addEventListener("blm-wake", onWake);
    window.addEventListener("blm-voice-continue", onContinue);
    return () => {
      window.removeEventListener("blm-wake", onWake);
      window.removeEventListener("blm-voice-continue", onContinue);
    };
  });

  return {
    recording,
    voiceMsg,
    toggleRecording,
    clearVoiceMsg: () => setVoiceMsg(null),
    startVoiceCommand,
  };
}
