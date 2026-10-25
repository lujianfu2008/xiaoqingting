// Lip-sync math: turning a live frequency/time-domain snapshot into viseme
// weights. Pure functions — the audio plumbing lives in ../speech.ts.

export interface LipShape {
  aa: number;
  ih: number;
  ou: number;
  ee: number;
  oh: number;
  level: number;
}

export const SILENT: LipShape = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0, level: 0 };

export const VISEMES = ["aa", "ih", "ou", "ee", "oh"] as const;

/** Fade every viseme toward zero (mouth closes smoothly). */
export function decayLip(current: LipShape, k: number): LipShape {
  current.aa *= k;
  current.ih *= k;
  current.ou *= k;
  current.ee *= k;
  current.oh *= k;
  current.level *= k;
  if (current.level < 0.002) current.level = 0;
  return current;
}

export function bandAvg(
  data: Uint8Array,
  fromHz: number,
  toHz: number,
  sampleRate: number,
): number {
  const nyquist = sampleRate / 2;
  const bins = data.length;
  const i0 = Math.max(0, Math.floor((fromHz / nyquist) * bins));
  const i1 = Math.min(bins - 1, Math.ceil((toHz / nyquist) * bins));
  if (i1 < i0) return 0;
  let sum = 0;
  for (let i = i0; i <= i1; i++) sum += data[i] ?? 0;
  return sum / (i1 - i0 + 1) / 255;
}

/**
 * Recompute `current` from one audio snapshot. Returns the same object so the
 * per-frame caller can hand it straight to the renderer.
 */
export function computeLip(
  current: LipShape,
  freqData: Uint8Array,
  timeData: Uint8Array,
  sampleRate: number,
): LipShape {
  let sumSq = 0;
  for (let i = 0; i < timeData.length; i++) {
    const v = ((timeData[i] ?? 128) - 128) / 128;
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / timeData.length);
  // Noise floor ~0.01; SAPI output sits well above it.
  const level = Math.max(0, Math.min(1, (rms - 0.008) * 4.2));

  const low = bandAvg(freqData, 80, 480, sampleRate);
  const mid = bandAvg(freqData, 480, 1500, sampleRate);
  const high = bandAvg(freqData, 1500, 3800, sampleRate);
  const total = low + mid + high;
  if (total <= 0.0001 || level <= 0.01) return decayLip(current, 0.6);

  // Openness follows loudness; the spectrum decides which vowel it looks like.
  const open = Math.min(1, level * 1.5);
  const sLow = low / total;
  const sMid = mid / total;
  const sHigh = high / total;

  // Attack fast (mouth opens on the syllable), release slightly slower.
  const smooth = (cur: number, target: number): number =>
    cur + (target - cur) * (target > cur ? 0.55 : 0.35);
  current.aa = smooth(current.aa, open * sLow);
  current.ou = smooth(current.ou, open * sMid * 0.9);
  current.oh = smooth(current.oh, open * (sLow + sMid) * 0.45);
  current.ih = smooth(current.ih, open * sHigh * 0.85);
  current.ee = smooth(current.ee, open * sHigh * 0.75);
  current.level = smooth(current.level, level);
  // VRM/BPM blendshapes sum their weights; keep the five visemes within 1 so
  // the mouth never over-distorts when two bands peak together.
  const sum = current.aa + current.ih + current.ou + current.ee + current.oh;
  if (sum > 1) {
    const k = 1 / sum;
    current.aa *= k;
    current.ih *= k;
    current.ou *= k;
    current.ee *= k;
    current.oh *= k;
  }
  return current;
}
