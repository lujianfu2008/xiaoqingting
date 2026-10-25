// 朗读播放：合成结果（WAV）交给 Web Audio 播放。
import {
  clearSource,
  current,
  ensureAudio,
  isCurrentSource,
  isSession,
  setPlaying,
  setSource,
  startSession,
} from "./state";
import { t } from "../i18n";

/** Stop playback and cancel any in-flight synthesis. */
export function stopAudio(): void {
  startSession();
  setPlaying(false);
  clearSource();
  current.aa = current.ih = current.ou = current.ee = current.oh = current.level = 0;
  void window.blm.stopSpeaking();
}

/**
 * Synthesize + play. Resolves when playback finishes (or immediately on
 * failure/stop). Never throws.
 */
export async function playSpoken(
  text: string,
  opts: { voice?: string; rate?: number; volume?: number } = {},
): Promise<{ ok: boolean; error?: string }> {
  const mine = startSession();
  clearSource();
  setPlaying(false);

  let result: { audio?: Uint8Array; error?: string };
  try {
    result = await window.blm.speakText(text, {
      voice: opts.voice,
      rate: opts.rate,
    });
  } catch {
    return { ok: false, error: t("tts.fail") };
  }
  if (!isSession(mine)) return { ok: false, error: "cancelled" };
  if (!result?.audio || result.audio.byteLength === 0) {
    return { ok: false, error: result?.error ?? t("tts.fail") };
  }

  const { ctx: c, analyser: a, gain } = ensureAudio();
  await c.resume().catch(() => undefined);

  let buffer: AudioBuffer;
  try {
    // Copy: decodeAudioData detaches the ArrayBuffer it is given.
    const copy = new Uint8Array(result.audio.byteLength);
    copy.set(result.audio);
    buffer = await c.decodeAudioData(copy.buffer);
  } catch {
    return { ok: false, error: t("tts.decodeFail") };
  }
  if (!isSession(mine)) return { ok: false, error: "cancelled" };

  gain.gain.value = Math.max(0, Math.min(1, (opts.volume ?? 100) / 100));

  const src = c.createBufferSource();
  src.buffer = buffer;
  src.connect(a);
  setSource(src);
  setPlaying(true);

  await new Promise<void>((resolve) => {
    src.onended = () => {
      if (isCurrentSource(src)) {
        setSource(null);
        setPlaying(false);
      }
      resolve();
    };
    try {
      src.start();
    } catch {
      resolve();
    }
  });

  if (!isSession(mine)) return { ok: false, error: "cancelled" };
  return { ok: true };
}
