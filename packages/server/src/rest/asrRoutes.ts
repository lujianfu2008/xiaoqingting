import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";

// Cloud ASR: client records short WAV audio, server forwards it to the
// transcription API (key stays server-side) and returns the recognized text.

const AsrRequest = z.object({
  audio_base64: z.string().min(64),
  mime: z.string().default("audio/wav"),
});

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

async function transcribe(audio: Buffer, mime: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), "audio.wav");
  form.append("model", config.asrModel);
  const res = await fetch(`${config.asrBaseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.asrApiKey}` },
    body: form,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`语音识别服务返回 ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const data = (await res.json()) as { text?: string };
  return data.text ?? "";
}

export function registerAsrRoutes(app: FastifyInstance): void {
  app.post("/api/asr", async (req, reply) => {
    const parsed = AsrRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    try {
      const audio = Buffer.from(parsed.data.audio_base64, "base64");
      if (audio.length > MAX_AUDIO_BYTES) {
        return reply.code(413).send({ error: "录音过长" });
      }
      const text = await transcribe(audio, parsed.data.mime);
      return { text };
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : "语音识别失败" });
    }
  });
}
