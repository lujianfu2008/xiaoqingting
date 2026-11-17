// 语音唤醒的常驻采音：麦克风保持打开（一次授权），每块先算 RMS 做门控——
// 门不放行或静音块直接丢弃，只有有声块才转 int16 经 IPC 喂给主进程的
// KeywordSpotter。采集参数与 voiceRecorder.ts 保持一致（16kHz 单声道 +
// 回声消除/降噪，让 TTS 朗读不易自触发）。
export interface WakeGates {
  /** false 期间丢弃一切音频（TTS 朗读/录音中/回复中/冷却等）。 */
  isActive(): boolean;
  /** 设备僵死回调（可选）：收到音频但长期全静音 → 监听自认坏死，
   * 调用方应整体重建监听（换回有效设备）。 */
  onDead?(): void;
}

export interface WakeListener {
  stop(): void;
}

/** 低于该 RMS 视为静音：不进 IPC，也不给主进程白耗解码。 */
const RMS_SILENCE = 0.012;

// 诊断快照（设置面板轮询展示，定位「喊了没反应」卡在哪一环）：
// ctxState = AudioContext 状态；recv = onaudioprocess 收到的块数
// （0 = 回调没在跑：ctx 暂停或设备流僵死）；gate = 被门控丢弃的
// 块数（一直涨 = 录音/朗读/弹窗把门关了）；silent = 过门但低于
// RMS 阈值的块数（一直涨而 sent 不动 = 设备在送静音）；sent =
// 真正喂进主进程的块数。
const wakeDiag = {
  ctxState: "off",
  recv: 0,
  gate: 0,
  silent: 0,
  sent: 0,
};

export function getWakeDiag(): typeof wakeDiag {
  return { ...wakeDiag };
}

/** AudioContext suspended → 尽力恢复；返回是否恢复成功。 */
async function resumeCtx(ctx: AudioContext): Promise<boolean> {
  if (ctx.state !== "suspended") return true;
  try {
    await ctx.resume();
    return ctx.state !== "suspended";
  } catch {
    return false;
  }
}

export async function startWakeListener(gates: WakeGates): Promise<WakeListener | null> {
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let processor: ScriptProcessorNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let dead = false; // 设备僵死标记：触发后丢弃一切块，等整体重建
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    ctx = new AudioContext({ sampleRate: 16000 });
    // 自动播放策略坑：文档还没有任何用户手势时创建的 AudioContext
    // 一律 suspended，且之后的手势**不会**自动唤醒它——重启自动登录
    // 的场景必踩，现象就是 onaudioprocess 永不触发、零报错、唤醒静默
    // 失效。立即尝试恢复（登录那一下的手势还在就能成），再把手势与
    // 定时兜底挂到整个监听生命周期上。
    const tryResume = (): void => {
      if (ctx && ctx.state === "suspended") {
        void resumeCtx(ctx).catch(() => undefined);
      }
    };
    tryResume();
    window.addEventListener("pointerdown", tryResume);
    window.addEventListener("keydown", tryResume);
    const resumeTimer = setInterval(tryResume, 4000);
    wakeDiag.ctxState = ctx.state;
    wakeDiag.recv = 0;
    wakeDiag.gate = 0;
    wakeDiag.silent = 0;
    wakeDiag.sent = 0;
    source = ctx.createMediaStreamSource(stream);
    processor = ctx.createScriptProcessor(2048, 1, 1);
    // 设备僵死看门狗：Windows 上切默认设备/独占模式被抢后 MediaStream
    // 不报错，onaudioprocess 还在跑但全是零。 recv 在涨而 sent 恒 0、
    // 过门静音块连超 ~51s（真静音环境也有底噪，不可能全零）→ 判僵死，
    // 一次性回调 onDead 让调用方整体重建监听。
    let silentRun = 0;
    const watchdog = setInterval(() => {
      if (dead) return;
      if (wakeDiag.recv > 300 && wakeDiag.sent === 0 && silentRun > 400) {
        dead = true;
        gates.onDead?.();
      }
    }, 10000);
    processor.onaudioprocess = (e) => {
      if (ctx) wakeDiag.ctxState = ctx.state;
      if (dead) return;
      const data = e.inputBuffer.getChannelData(0);
      wakeDiag.recv++;
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      if (!gates.isActive()) {
        wakeDiag.gate++;
        return;
      }
      if (rms < RMS_SILENCE) {
        wakeDiag.silent++;
        silentRun++;
        return;
      }
      silentRun = 0;
      const out = new Int16Array(data.length);
      for (let i = 0; i < data.length; i++) {
        const s = Math.max(-1, Math.min(1, data[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      wakeDiag.sent++;
      window.blm.wakeChunk(out.buffer);
    };
    source.connect(processor);
    processor.connect(ctx.destination);
    return {
      stop(): void {
        dead = true;
        try {
          clearInterval(watchdog);
          clearInterval(resumeTimer);
          window.removeEventListener("pointerdown", tryResume);
          window.removeEventListener("keydown", tryResume);
          wakeDiag.ctxState = "off";
          processor?.disconnect();
          source?.disconnect();
          stream?.getTracks().forEach((t) => t.stop());
          void ctx?.close();
        } finally {
          window.blm.wakeStop();
        }
      },
    };
  } catch {
    processor?.disconnect();
    source?.disconnect();
    stream?.getTracks().forEach((t) => t.stop());
    void ctx?.close();
    window.blm.wakeStop();
    return null; // 麦克风被拒/不可用，由调用方提示
  }
}
