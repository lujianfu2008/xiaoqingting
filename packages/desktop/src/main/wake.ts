import path from "node:path";
import fs from "node:fs";
import { app, type WebContents } from "electron";
// 语音唤醒：sherpa-onnx KeywordSpotter（zipformer wenetspeech 3.3M，int8）。
// 纯 NAPI 原生模块，与 asr.ts 一样直接跑在主进程。唤醒词在运行时由
// pinyin-pro 转成模型的 ppinyin token 序列生成 keywords.txt——设置里改词
// 立即生效，无需训练；同音叫法（小蜻/小青/小情）读法相同，天然自动兼容。
const MODEL_DIR = "sherpa-kws";

export type WakeSensitivity = "low" | "medium" | "high";
// keywordsThreshold 越低越容易命中。中档对齐 sherpa-onnx 官方示例默认 0.25；
// 本机用官方 test_wavs 验证过：列表内语音全命中、白噪声与无关语音零误触。
const THRESHOLD: Record<WakeSensitivity, number> = { low: 0.4, medium: 0.25, high: 0.18 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sherpa: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spotter: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stream: any = null;
// "词表|灵敏度"指纹：没变化就不重建（重建要重新加载模型）。
let configKey = "";

function modelDir(): string {
  const name = MODEL_DIR;
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "models", name);
  }
  // dev: out/main -> packages/desktop/models
  return path.join(__dirname, "../../models", name);
}

/** 在模型目录里按前缀找 onnx（优先 int8，容忍文件名细节差异）。 */
function pickOnnx(dir: string, prefix: string): string {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".onnx"));
  const hit =
    files.find((f) => f.startsWith(prefix) && f.includes("int8")) ??
    files.find((f) => f.startsWith(prefix));
  if (!hit) throw new Error(`语音唤醒模型缺失（${dir} 中没有 ${prefix}*.onnx）`);
  return path.join(dir, hit);
}

/** 把唤醒词转成 keywords.txt 的行：`x iǎo q īng @小蜻蜓`。 */
function keywordLines(
  words: string[],
  tokens: Set<string>,
): { lines: string[]; skipped: string[] } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { pinyin } = require("pinyin-pro");
  const lines: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const word of words) {
    const w = word.trim();
    if (!w) continue;
    // 每个字 = 声母 + 带调韵母（零声母字只有韵母，如 爱 → ài）。
    const toks: string[] = [];
    let ok = true;
    for (const ch of w) {
      const ini = pinyin(ch, { pattern: "initial", type: "string" });
      const fin = pinyin(ch, { pattern: "final", toneType: "symbol", type: "string" });
      for (const tk of [ini, fin]) {
        if (!tk) continue;
        if (!tokens.has(tk)) {
          ok = false;
          break;
        }
        toks.push(tk);
      }
      if (!ok) break;
    }
    if (!ok || toks.length === 0) {
      skipped.push(w);
      continue;
    }
    const key = toks.join(" ");
    if (seen.has(key)) continue; // 同音词只留一条
    seen.add(key);
    lines.push(`${key} @${w}`);
  }
  return { lines, skipped };
}

/** 建立/更新 KeywordSpotter。返回 { error? }，错误信息已按中文文案组织。 */
export function configureWake(
  words: string[],
  sensitivity: WakeSensitivity,
): { error?: string } {
  try {
    const dir = modelDir();
    const tokensPath = path.join(dir, "tokens.txt");
    if (!fs.existsSync(tokensPath)) {
      return { error: `语音唤醒模型缺失（${dir}）` };
    }
    const tokens = new Set(
      fs
        .readFileSync(tokensPath, "utf8")
        .split("\n")
        .map((l) => l.trim().split(/\s+/)[0])
        .filter(Boolean),
    );
    const { lines, skipped } = keywordLines(words, tokens);
    if (lines.length === 0) {
      return { error: `没有可用的唤醒词${skipped.length ? `（无法识别：${skipped.join("、")}）` : ""}` };
    }
    const key = `${lines.join("|")}::${sensitivity}`;
    if (spotter && key === configKey) return {};
    if (!sherpa) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      sherpa = require("sherpa-onnx-node");
    }
    const keywordsPath = path.join(app.getPath("userData"), "wake-keywords.txt");
    fs.writeFileSync(keywordsPath, lines.join("\n") + "\n", "utf8");
    spotter = new sherpa.KeywordSpotter({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: pickOnnx(dir, "encoder"),
          decoder: pickOnnx(dir, "decoder"),
          joiner: pickOnnx(dir, "joiner"),
        },
        tokens: tokensPath,
        numThreads: 1,
        sampleRate: 16000,
        featureDim: 80,
      },
      keywordsFile: keywordsPath,
      maxActivePaths: 4,
      numTrailingBlanks: 1,
      keywordsScore: 1.0,
      keywordsThreshold: THRESHOLD[sensitivity] ?? THRESHOLD.medium,
    });
    stream = spotter.createStream();
    configKey = key;
    return {};
  } catch (e) {
    spotter = null;
    stream = null;
    configKey = "";
    return { error: e instanceof Error ? e.message : "语音唤醒初始化失败" };
  }
}

/** 喂入一块 16kHz mono int16 PCM；命中唤醒词时回推 blm:wake:detected。 */
export function feedWakeChunk(pcm: ArrayBuffer, sender: WebContents): void {
  if (!spotter || !stream) return;
  try {
    const len = pcm.byteLength >> 1;
    const samples = new Float32Array(len);
    const view = new DataView(pcm);
    for (let i = 0; i < len; i++) {
      samples[i] = view.getInt16(i * 2, true) / 32768;
    }
    stream.acceptWaveform({ sampleRate: 16000, samples });
    while (spotter.isReady(stream)) spotter.decode(stream);
    const r = spotter.getResult(stream);
    if (r && typeof r.keyword === "string" && r.keyword) {
      spotter.reset(stream); // 立即复位，连续喊两次也能两次唤醒
      if (!sender.isDestroyed()) sender.send("blm:wake:detected", r.keyword);
    }
  } catch {
    // 单块坏数据绝不能杀死常驻监听
  }
}

/** 停止监听（渲染端关掉开关/释放麦克风时调用，丢弃未完的解码状态）。 */
export function stopWakeStream(): void {
  if (spotter && stream) {
    try {
      spotter.reset(stream);
    } catch {
      // ignore
    }
  }
}
