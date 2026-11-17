import path from "node:path";
import fs from "node:fs";
import { modelDirOf } from "./modelFetch";

// Local offline ASR: sherpa-onnx Paraformer (Chinese small, int8).
// Pure NAPI native addon — works directly in the Electron main process.
// (The previous engine, vosk+ffi-napi, was incompatible with Electron's V8.)
// 模型不再随安装包分发：首次使用从所连服务器下载（modelFetch.ts），
// 已装/手动放置的模型直接复用。

const MODEL_DIR = "sherpa-paraformer";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SherpaModule = any;

let sherpa: SherpaModule | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let recognizer: any = null;

function modelDir(): string {
  return modelDirOf(MODEL_DIR);
}

function loadRecognizer(): boolean {
  if (recognizer) return true;
  try {
    if (!sherpa) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      sherpa = require("sherpa-onnx-node");
    }
    const dir = modelDir();
    if (!fs.existsSync(path.join(dir, "tokens.txt"))) {
      throw new Error("语音模型未就绪（设置 → 常规 → 语音模型 里下载，或手动放置）");
    }
    recognizer = new sherpa.OfflineRecognizer({
      modelConfig: {
        paraformer: { model: path.join(dir, "model.int8.onnx") },
        tokens: path.join(dir, "tokens.txt"),
        numThreads: 2,
        sampleRate: 16000,
        decodingMethod: "greedy_search",
      },
    });
    return true;
  } catch (e) {
    console.error("sherpa-onnx ASR 初始化失败:", e);
    recognizer = null;
    return false;
  }
}

/** Transcribe raw 16kHz mono int16 PCM. Returns recognized text ("" if none).
 * pauses 是停顿切分点（int16 样本位，渲染端按 ~0.5s 静音检测）：按点分段逐段
 * 识别再用逗号拼接——说话停顿处落逗号，弥补 Paraformer 整段识别无标点。 */
export function transcribePcm(pcm: ArrayBuffer, pauses?: number[]): string {
  if (!loadRecognizer()) {
    throw new Error("语音模型未就绪（设置 → 常规 → 语音模型 里下载）");
  }
  const len = pcm.byteLength >> 1;
  const samples = new Float32Array(len);
  const view = new DataView(pcm);
  for (let i = 0; i < len; i++) {
    samples[i] = view.getInt16(i * 2, true) / 32768;
  }
  const bounds = [
    0,
    ...(pauses ?? []).filter((p) => Number.isFinite(p) && p > 0 && p < len).sort((a, b) => a - b),
    len,
  ];
  const pieces: string[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const seg = samples.subarray(bounds[i], bounds[i + 1]);
    if (seg.length < 1600) continue; // <0.1s 的碎片不送识别
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: 16000, samples: seg });
    recognizer.decode(stream);
    const text = String(recognizer.getResult(stream).text ?? "").trim();
    if (text) pieces.push(text);
  }
  return pieces.join("，");
}
