import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanForSpeech } from "./text";
import { DEFAULT_VOICE } from "./voices";

// Synthesize via Windows SAPI into a temp WAV and return its bytes.

export interface TtsOptions {
  voice?: string; // SAPI voice name; empty = default Chinese voice
  rate?: number; // SAPI rate, -10..10
  volume?: number; // 0..100 (applied by the renderer's gain node)
}

const SYNTH_TIMEOUT_MS = 60000;

const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;

let synth: ChildProcess | null = null;

/** Abort an in-flight synthesis (user pressed stop / a new utterance started). */
export function stopSpeaking(): void {
  if (!synth) return;
  try {
    synth.kill("SIGKILL");
  } catch {
    // already gone
  }
  synth = null;
}

/**
 * Synthesize text to a WAV buffer. Resolves with `{ audio }` on success or
 * `{ error }` when unsupported/failed/aborted — never throws, because TTS
 * failure must not break the chat.
 */
export async function synthesizeSpeech(
  text: string,
  opts: TtsOptions = {},
): Promise<{ audio?: Uint8Array; error?: string }> {
  if (process.platform !== "win32") return { error: "当前系统不支持本地语音合成" };
  const cleaned = cleanForSpeech(text);
  if (!cleaned) return { error: "没有可朗读的内容" };

  // A new utterance supersedes whatever is still synthesizing.
  stopSpeaking();

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const txtFile = path.join(os.tmpdir(), `blm-tts-${stamp}.txt`);
  const wavFile = path.join(os.tmpdir(), `blm-tts-${stamp}.wav`);
  const cleanup = (): void => {
    for (const f of [txtFile, wavFile]) {
      try {
        fs.unlinkSync(f);
      } catch {
        // already gone
      }
    }
  };
  try {
    fs.writeFileSync(txtFile, cleaned, "utf8");
  } catch {
    return { error: "语音合成失败" };
  }

  const voice = opts.voice?.trim() || DEFAULT_VOICE;
  const rate = Math.max(-10, Math.min(10, opts.rate ?? 0));
  const script = [
    "Add-Type -AssemblyName System.Speech",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    `try { $s.SelectVoice(${q(voice)}) } catch {}`,
    `$s.Rate = ${rate}`,
    `$s.SetOutputToWaveFile(${q(wavFile)})`,
    `$text = Get-Content -Raw -Encoding UTF8 ${q(txtFile)}`,
    "$s.Speak($text)",
    "$s.SetOutputToNull()",
    "$s.Dispose()",
  ].join("; ");

  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: { audio?: Uint8Array; error?: string }): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      cleanup();
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = spawn(
        "powershell.exe",
        ["-NoProfile", "-WindowStyle", "Hidden", "-Command", script],
        { stdio: "ignore", windowsHide: true },
      );
    } catch {
      finish({ error: "语音合成失败" });
      return;
    }
    synth = child;
    child.on("error", () => {
      if (synth === child) synth = null;
      finish({ error: "语音合成失败" });
    });
    child.on("close", (code) => {
      if (synth === child) synth = null;
      if (code !== 0) {
        finish({ error: "语音合成失败" });
        return;
      }
      try {
        const buf = fs.readFileSync(wavFile);
        if (buf.length <= 44) {
          finish({ error: "语音合成失败" });
          return;
        }
        finish({ audio: new Uint8Array(buf) });
      } catch {
        finish({ error: "语音合成失败" });
      }
    });
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      finish({ error: "语音合成超时" });
    }, SYNTH_TIMEOUT_MS);
  });
}
