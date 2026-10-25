// Local TTS facade: SAPI voice discovery + synthesis to a WAV buffer. Split
// into ./voices (enumeration), ./synth (PowerShell SAPI run) and ./text (the
// cleanup applied before speaking).

export { cleanForSpeech } from "./text";
export { listVoices, DEFAULT_VOICE } from "./voices";
export { synthesizeSpeech, stopSpeaking, type TtsOptions } from "./synth";
