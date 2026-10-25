import path from "node:path";
import fs from "node:fs";
import { app } from "electron";

// Local offline ASR: sherpa-onnx Paraformer (Chinese small, int8).
// Pure NAPI native addon — works directly in the Electron main process.
// (The previous engine, vosk+ffi-napi, was incompatible with Electron's V8.)

const MODEL_DIR = "sherpa-paraformer";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SherpaModule = any;

let sherpa: SherpaModule | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let recognizer: any = null;

function modelDir(): string {
  const name = MODEL_DIR;
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "models", name);
  }
  // dev: out/main -> packages/desktop/models
  return path.join(__dirname, "../../models", name);
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
      throw new Error(`语音模型缺失（${dir}）`);
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

/** Transcribe raw 16kHz mono int16 PCM. Returns recognized text ("" if none). */
export function transcribePcm(pcm: ArrayBuffer): string {
  if (!loadRecognizer()) {
    throw new Error("语音识别引擎未就绪，请重启应用重试");
  }
  const len = pcm.byteLength >> 1;
  const samples = new Float32Array(len);
  const view = new DataView(pcm);
  for (let i = 0; i < len; i++) {
    samples[i] = view.getInt16(i * 2, true) / 32768;
  }
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: 16000, samples });
  recognizer.decode(stream);
  return String(recognizer.getResult(stream).text ?? "").trim();
}
