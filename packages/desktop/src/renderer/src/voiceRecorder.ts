// In-renderer mic capture for the local offline ASR (Vosk in the main
// process): getUserMedia + AudioContext, 16kHz mono PCM, delivered as an
// int16 ArrayBuffer over IPC. No cloud call, no file conversion.

export interface WavRecorder {
  start(): Promise<void>;
  stop(): Promise<ArrayBuffer | null>;
}

export function createWavRecorder(): WavRecorder {
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let processor: ScriptProcessorNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let chunks: Float32Array[] = [];

  async function start(): Promise<void> {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    ctx = new AudioContext({ sampleRate: 16000 });
    source = ctx.createMediaStreamSource(stream);
    processor = ctx.createScriptProcessor(4096, 1, 1);
    chunks = [];
    processor.onaudioprocess = (e) => {
      chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
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

/** Send recorded PCM to the local Vosk engine in the main process. */
export async function transcribeLocal(pcm: ArrayBuffer): Promise<string> {
  const res = await window.blm.transcribeLocalPcm(pcm);
  if (res.error) throw new Error(res.error);
  return (res.text ?? "").trim();
}
