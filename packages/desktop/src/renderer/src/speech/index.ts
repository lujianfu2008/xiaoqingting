// 朗读播放 + 真对口型。
//
// 主进程把 SAPI 合成结果写成 WAV 交回来，这里用 Web Audio 播放，并接一个
// AnalyserNode 实时分析频谱：总响度决定嘴张多大，低/中/高频段决定口型
// (aa / ou / ee …)。数字人和小蜻蜓每帧读 readLipSync() 即可。
//
// Split into ./speech/{state,player,viseme}.ts; this barrel keeps the public
// surface identical (`../speech`).
import { current, lipSnapshot } from "./state";
import { computeLip, decayLip, type LipShape } from "./viseme";

export type { LipShape };
export { playSpoken, stopAudio } from "./player";

/**
 * Current mouth shape, sampled from the live audio. Call once per frame.
 * Returns decaying zeros when nothing is playing, so the mouth closes smoothly.
 */
export function readLipSync(): LipShape {
  const snap = lipSnapshot();
  if (!snap) return decayLip(current, 0.72);
  snap.analyser.getByteFrequencyData(snap.freqData);
  snap.analyser.getByteTimeDomainData(snap.timeData);
  return computeLip(current, snap.freqData, snap.timeData, snap.ctx.sampleRate);
}
