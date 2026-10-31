// 语音唤醒的常驻采音：麦克风保持打开（一次授权），每块先算 RMS 做门控——
// 门不放行或静音块直接丢弃，只有有声块才转 int16 经 IPC 喂给主进程的
// KeywordSpotter。采集参数与 voiceRecorder.ts 保持一致（16kHz 单声道 +
// 回声消除/降噪，让 TTS 朗读不易自触发）。
export interface WakeGates {
  /** false 期间丢弃一切音频（TTS 朗读/录音中/回复中/冷却等）。 */
  isActive(): boolean;
}

export interface WakeListener {
  stop(): void;
}

/** 低于该 RMS 视为静音：不进 IPC，也不给主进程白耗解码。 */
const RMS_SILENCE = 0.012;

export async function startWakeListener(gates: WakeGates): Promise<WakeListener | null> {
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let processor: ScriptProcessorNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    ctx = new AudioContext({ sampleRate: 16000 });
    source = ctx.createMediaStreamSource(stream);
    processor = ctx.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      if (!gates.isActive()) return;
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      if (Math.sqrt(sum / data.length) < RMS_SILENCE) return;
      const out = new Int16Array(data.length);
      for (let i = 0; i < data.length; i++) {
        const s = Math.max(-1, Math.min(1, data[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      window.blm.wakeChunk(out.buffer);
    };
    source.connect(processor);
    processor.connect(ctx.destination);
  } catch {
    processor?.disconnect();
    source?.disconnect();
    stream?.getTracks().forEach((t) => t.stop());
    void ctx?.close();
    window.blm.wakeStop();
    return null; // 麦克风被拒/不可用，由调用方提示
  }
  return {
    stop(): void {
      try {
        processor.disconnect();
        source.disconnect();
        stream?.getTracks().forEach((t) => t.stop());
        void ctx.close();
      } finally {
        window.blm.wakeStop();
      }
    },
  };
}
