import { useEffect, useRef } from "react";
import { useStore } from "./store";
import { startWakeListener, type WakeListener } from "./wakeListener";
import { t } from "./i18n";

/** 命中后的冷却：同一句连喊只算一次，也给录音启动留出时间。 */
const COOLDOWN_MS = 1500;
/** 设置里改唤醒词/灵敏度后，防抖再重建 KeywordSpotter。 */
const RECONFIGURE_DEBOUNCE_MS = 500;
/** 连续对话编排的巡检周期与门开后的续听宽限（等 send/busy 置位，避免抢跑）。 */
const CONT_TICK_MS = 400;
const CONT_GRACE_MS = 800;

/** 命中提示音（两声上行短叮咚）。无用户手势时 AudioContext 可能被挂起，先 resume。 */
function playWakeCue(): void {
  try {
    const ctx = new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const t0 = ctx.currentTime + 0.02;
    [880, 1320].forEach((freq, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0 + i * 0.1);
      g.gain.exponentialRampToValueAtTime(0.16, t0 + i * 0.1 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.1 + 0.18);
      o.connect(g).connect(ctx.destination);
      o.start(t0 + i * 0.1);
      o.stop(t0 + i * 0.1 + 0.22);
    });
    setTimeout(() => void ctx.close().catch(() => undefined), 900);
  } catch {
    // 提示音只是锦上添花，失败不影响唤醒
  }
}

/**
 * 语音唤醒生命周期（挂在 App，登录后常驻）：
 * 词表/灵敏度变化 → 防抖后重建主进程 KeywordSpotter → 打开常驻麦克风监听。
 * 命中由主进程推 blm:wake:detected：提示音 + 拉起窗口 + 派发 blm-wake 事件，
 * 录音流程在 useVoiceInput 里响应（复用空格语音的同一套逻辑）。
 */
export function useWakeWord(): void {
  const token = useStore((s) => s.token);
  const wakeEnabled = useStore((s) => s.voiceSettings.wakeEnabled);
  const wakeWords = useStore((s) => s.voiceSettings.wakeWords);
  const wakeSensitivity = useStore((s) => s.voiceSettings.wakeSensitivity);

  const lastDetectedRef = useRef(0);
  const listenerRef = useRef<WakeListener | null>(null);
  // 连续对话：静默退出时限（时间戳）与「门何时打开」（宽限用）。
  const contExpireAtRef = useRef(0);
  const contGateSinceRef = useRef(Date.now());

  // 命中事件订阅只挂一次；回调只碰 ref / IPC，无需随状态重挂。
  useEffect(() => {
    return window.blm.onWakeDetected((keyword) => {
      lastDetectedRef.current = Date.now();
      void window.blm.focusWindow();
      playWakeCue();
      // 开着连续对话：这一刻起算静默时限（只有真实说话会续期）。
      const vs = useStore.getState().voiceSettings;
      if (vs.wakeContinuous) {
        useStore.getState().setContinuousVoice(true);
        contExpireAtRef.current = Date.now() + vs.wakeContinuousSecs * 1000;
      }
      window.dispatchEvent(new CustomEvent("blm-wake", { detail: keyword }));
    });
  }, []);

  // 连续对话编排（挂一次）：说完一句话（blm-voice-utterance）给时限续期；
  // 每 400ms 巡检——门开（没在录/没在念/没在回复/没弹窗）超过宽限就派发
  // blm-voice-continue 续听下一段；空闲续听循环不续期，静默超过时限自动
  // 退出连续模式回到待唤醒。
  useEffect(() => {
    const onUtterance = (): void => {
      const s = useStore.getState();
      if (s.continuousVoice) {
        contExpireAtRef.current = Date.now() + s.voiceSettings.wakeContinuousSecs * 1000;
      }
    };
    window.addEventListener("blm-voice-utterance", onUtterance);
    const timer = setInterval(() => {
      const s = useStore.getState();
      if (!s.continuousVoice) return;
      if (!s.voiceSettings.wakeContinuous) {
        s.setContinuousVoice(false); // 设置里关掉了开关
        return;
      }
      const sid = s.currentSessionId;
      const gated =
        s.recording ||
        s.speaking ||
        s.pendingPermission ||
        s.pendingExec ||
        (sid ? (s.busy[sid] ?? false) : false);
      const now = Date.now();
      if (gated) {
        contGateSinceRef.current = now;
        return;
      }
      if (now >= contExpireAtRef.current) {
        s.setContinuousVoice(false); // 静默超时 → 回到待唤醒
        return;
      }
      if (now - contGateSinceRef.current >= CONT_GRACE_MS) {
        contGateSinceRef.current = now; // 派发到 recording 置位前不重复派
        window.dispatchEvent(new CustomEvent("blm-voice-continue"));
      }
    }, CONT_TICK_MS);
    return () => {
      window.removeEventListener("blm-voice-utterance", onUtterance);
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!token || !wakeEnabled) {
      listenerRef.current?.stop();
      listenerRef.current = null;
      useStore.getState().setWakeError(null);
      useStore.getState().setContinuousVoice(false); // 唤醒关了，连续对话随之退
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const words = wakeWords
          .split(/[,，]/)
          .map((w) => w.trim())
          .filter(Boolean);
        const res = await window.blm.wakeConfigure(words, wakeSensitivity);
        if (cancelled) return;
        listenerRef.current?.stop();
        listenerRef.current = null;
        if (res.error) {
          useStore.getState().setWakeError(res.error);
          return;
        }
        useStore.getState().setWakeError(null);
        listenerRef.current = await startWakeListener({
          isActive: () => {
            const s = useStore.getState();
            if (s.recording || s.speaking) return false; // 录音中/朗读中不听
            if (s.pendingPermission || s.pendingExec) return false; // 确认弹窗打开时不听
            // 智能体回复中也继续监听：语音补充会并入当前回合（与文字一致），
            // 不必把用户晾到回复结束。
            return Date.now() - lastDetectedRef.current >= COOLDOWN_MS;
          },
        });
        if (!listenerRef.current) useStore.getState().setWakeError(t("vm.micDenied"));
      })();
    }, RECONFIGURE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      // 唤醒重建/卸载时连续对话一并退出（重建后从待唤醒重新开始）。
      useStore.getState().setContinuousVoice(false);
    };
  }, [token, wakeEnabled, wakeWords, wakeSensitivity]);

  // 卸载兜底：不留麦克风。
  useEffect(
    () => () => {
      listenerRef.current?.stop();
      listenerRef.current = null;
    },
    [],
  );
}
