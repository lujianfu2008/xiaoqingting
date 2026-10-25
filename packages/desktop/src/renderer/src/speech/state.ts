// Shared mutable singletons for the speech player: the Web Audio graph, the
// current source node, the play session counter and the live lip shape.
import type { LipShape } from "./viseme";

export interface AudioGraph {
  ctx: AudioContext;
  analyser: AnalyserNode;
  gain: GainNode;
}

let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let gainNode: GainNode | null = null;
let source: AudioBufferSourceNode | null = null;
let freqData: Uint8Array<ArrayBuffer> | null = null;
let timeData: Uint8Array<ArrayBuffer> | null = null;
let playing = false;
// Bumped on every play/stop so a late synthesis result can be discarded.
let session = 0;

export const current: LipShape = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0, level: 0 };

export function ensureAudio(): AudioGraph {
  if (!ctx || !analyser || !gainNode) {
    const c = new AudioContext();
    const a = c.createAnalyser();
    a.fftSize = 1024;
    a.smoothingTimeConstant = 0.55;
    const g = c.createGain();
    // source -> analyser -> gain -> speakers: lip-sync sees full-scale signal
    // regardless of the user's volume setting.
    a.connect(g);
    g.connect(c.destination);
    ctx = c;
    analyser = a;
    gainNode = g;
    freqData = new Uint8Array(a.frequencyBinCount);
    timeData = new Uint8Array(a.fftSize);
  }
  return { ctx, analyser, gain: gainNode };
}

/** Drop the current source node (stopping it first if it is live). */
export function clearSource(): void {
  if (source) {
    try {
      source.onended = null;
      source.stop();
    } catch {
      // already stopped
    }
    source = null;
  }
}

export function setSource(src: AudioBufferSourceNode | null): AudioBufferSourceNode | null {
  source = src;
  return source;
}

export function isCurrentSource(src: AudioBufferSourceNode): boolean {
  return source === src;
}

export function startSession(): number {
  return ++session;
}

export function isSession(id: number): boolean {
  return id === session;
}

export function setPlaying(v: boolean): void {
  playing = v;
}

export interface LipSnapshot {
  ctx: AudioContext;
  analyser: AnalyserNode;
  freqData: Uint8Array<ArrayBuffer>;
  timeData: Uint8Array<ArrayBuffer>;
}

/** Live analyser snapshot, or null when nothing is playing. */
export function lipSnapshot(): LipSnapshot | null {
  if (!playing || !analyser || !freqData || !timeData || !ctx) return null;
  return { ctx, analyser, freqData, timeData };
}
