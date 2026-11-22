import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { AttachmentUploadRequest } from "@blm/protocol";
import { config } from "../config.js";
import { Store, sharedWithUser } from "../store.js";

// 共享会话附件托管：共享会话/协作线程里粘贴的文件与图片上传到服务端，
// 消息里的 [附件] 行带 att:<sessionId>/<id> 引用。协作者的查看器与引擎
// read_attachment 都按引用取回字节——附件字节只存在于发送方本机的旧模式
// 在共享会话里必然跨机不可达（宿主/协作者两台机器）。访问面与会话发言
// 同一判定（主人恒可；其余仅共享可见——协作线程的负责人已并入 shared_with）。
// 生命周期随会话：deleteSession 一并清目录。

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 与桌面 read_attachment 上限一致
const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
};

function attachmentsRoot(): string {
  return path.join(config.dataDir, "attachments");
}

function attachmentDir(sessionId: string): string {
  // sessionId 是 uuid，仍然消毒兜底（路径只进 data/attachments）。
  const sid = sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(attachmentsRoot(), sid);
}

/** 发言同一判定的访问守卫：主人恒可；其余仅共享可见。 */
function canAccess(
  store: Store,
  userId: string,
  sessionId: string,
): { ok: true } | { ok: false; code: number; error: string } {
  const rec = store.getSession(sessionId);
  if (!rec) return { ok: false, code: 404, error: "not_found" };
  if (rec.user_id !== userId && !(rec.shared && sharedWithUser(rec, userId))) {
    return { ok: false, code: 403, error: "forbidden" };
  }
  return { ok: true };
}

export function registerAttachmentRoutes(
  app: FastifyInstance,
  store: Store,
): void {
  // 上传（base64 随 JSON）：bodyLimit 覆盖 12MB base64 + JSON 开销。
  app.post(
    "/api/sessions/:id/attachments",
    { bodyLimit: 20 * 1024 * 1024 },
    (req, reply) => {
      const sessionId = (req.params as { id: string }).id;
      const access = canAccess(store, req.userId, sessionId);
      if (!access.ok) return reply.code(access.code).send({ error: access.error });
      const parsed = AttachmentUploadRequest.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
      const buf = Buffer.from(parsed.data.data, "base64");
      if (buf.length === 0) return reply.code(400).send({ error: "invalid_request" });
      if (buf.length > MAX_ATTACHMENT_BYTES) {
        return reply.code(400).send({ error: "too_large" });
      }
      const safe = parsed.data.name.replace(/[\\/:*?"<>|\r\n]/g, "_").slice(-120) || "file";
      const dir = attachmentDir(sessionId);
      fs.mkdirSync(dir, { recursive: true });
      const id = crypto.randomUUID();
      fs.writeFileSync(path.join(dir, `${id}-${safe}`), buf);
      return { ok: true as const, id, name: safe };
    },
  );

  // 下载（原始字节，按扩展名给 content-type）：查看器取流与引擎侧
  // read_attachment 取回共用这条。
  app.get("/api/sessions/:id/attachments/:aid", (req, reply) => {
    const { id: sessionId, aid } = req.params as { id: string; aid: string };
    const access = canAccess(store, req.userId, sessionId);
    if (!access.ok) return reply.code(access.code).send({ error: access.error });
    // aid 不参与路径拼接（目录遍历面）：只在目录里按文件名前缀匹配。
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(aid)) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const dir = attachmentDir(sessionId);
    let hit: string | undefined;
    try {
      hit = fs.readdirSync(dir).find((f) => f.startsWith(`${aid}-`));
    } catch {
      return reply.code(404).send({ error: "not_found" });
    }
    if (!hit) return reply.code(404).send({ error: "not_found" });
    const full = path.join(dir, hit);
    try {
      const buf = fs.readFileSync(full);
      const ext = path.extname(hit).toLowerCase();
      reply.header("Content-Type", CONTENT_TYPES[ext] ?? "application/octet-stream");
      reply.header("Content-Length", buf.length);
      return reply.send(buf);
    } catch {
      return reply.code(404).send({ error: "not_found" });
    }
  });
}
