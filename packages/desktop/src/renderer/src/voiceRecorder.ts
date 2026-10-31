// In-renderer mic capture for the local offline ASR (Vosk in the main
// process): getUserMedia + AudioContext, 16kHz mono PCM, delivered as an
// int16 ArrayBuffer over IPC. No cloud call, no file conversion.

export interface WavRecorder {
  start(): Promise<void>;
  stop(): Promise<ArrayBuffer | null>;
}

// 停顿检测：有声之后连续这么多块（4096 样本 @16kHz ≈ 256ms/块）低于阈值，
// 记一次停顿——约 0.5s 的停顿才落一个逗号，避免字间换气被切碎。
const PAUSE_SILENT_CHUNKS = 2;
// 高于该 RMS 视为有声（与 useVoiceInput 的语音检测阈值一致）。
const VOICE_RMS = 0.02;

export function createWavRecorder(opts?: {
  onLevel?: (rms: number) => void;
  /** 传入数组（引用）即启用停顿检测：录音中每次停顿把切分样本位推入该数组，
   * 识别端按点分段出逗号（见 main/asr.ts transcribePcm）。 */
  pauses?: number[];
}): WavRecorder {
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let processor: ScriptProcessorNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let chunks: Float32Array[] = [];
  // 停顿检测状态：累计样本位 / 是否处于有声段 / 连续静音块数 / 最后有声块末尾。
  let totalSamples = 0;
  let voiced = false;
  let silentRun = 0;
  let lastVoicedEnd = 0;

  async function start(): Promise<void> {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    ctx = new AudioContext({ sampleRate: 16000 });
    source = ctx.createMediaStreamSource(stream);
    processor = ctx.createScriptProcessor(4096, 1, 1);
    chunks = [];
    totalSamples = 0;
    voiced = false;
    silentRun = 0;
    lastVoicedEnd = 0;
    processor.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(data));
      // 实时电平：语音唤醒的"说完静音自动停"靠它判断；顺带做停顿检测。
      if (opts?.onLevel || opts?.pauses) {
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length);
        if (opts?.pauses) {
          if (rms >= VOICE_RMS) {
            voiced = true;
            silentRun = 0;
            lastVoicedEnd = totalSamples + data.length;
          } else if (voiced) {
            silentRun++;
            if (silentRun >= PAUSE_SILENT_CHUNKS) {
              // 停顿中点记为切分位；之后要重新出声才算下一段。
              opts.pauses.push(Math.round((lastVoicedEnd + totalSamples + data.length) / 2));
              voiced = false;
              silentRun = 0;
            }
          }
        }
        if (opts?.onLevel) opts.onLevel(rms);
      }
      totalSamples += data.length;
    };
    source.connect(processor);
    processor.connect(ctx.destination);
  }

  async function stop(): Promise<ArrayBuffer | null> {
    let sampleRate = 16000;
    try {
      sampleRate = ctx?.sampleRate ?? 16000;
      processor?.disconnect();
      source?.disconnect();
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close();
    } finally {
      processor = null;
      source = null;
      stream = null;
      ctx = null;
    }
    if (chunks.length === 0) return null;
    const pcm = mergeChunks(chunks);
    chunks = [];
    return floatToInt16(pcm);
  }

  return { start, stop };
}

function mergeChunks(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function floatToInt16(samples: Float32Array): ArrayBuffer {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out.buffer;
}

/** Send recorded PCM to the local ASR engine in the main process.
 * pauses（createWavRecorder 的停顿切分位）让停顿处出逗号。 */
export async function transcribeLocal(pcm: ArrayBuffer, pauses?: number[]): Promise<string> {
  const res = await window.blm.transcribeLocalPcm(pcm, pauses);
  if (res.error) throw new Error(res.error);
  return (res.text ?? "").trim();
}
