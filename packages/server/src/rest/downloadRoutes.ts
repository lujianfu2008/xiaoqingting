import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

// 更新包分发：GET /download/:file 提供部署目录 UPDATE_DIR
// （默认 data/update/）里的白名单文件（安装包 / latest.yml /
// blockmap）。桌面端 electron-updater 的更新源即
// <服务器地址>/download/，部署时把打包产物三件套放进去即可。
// 只读单文件、路径拼死白名单，不列目录、不下载任意路径。
// 支持 Range/206：electron-updater 的差量下载靠它按块拉增量，
// 拿不到 206 会退化成两路并发整包下载，弱网下动辄二十分钟然后断流。

const MIME: Record<string, string> = {
  ".exe": "application/octet-stream",
  ".yml": "text/yaml; charset=utf-8",
  ".blockmap": "application/zip",
};

// 解析单段 Range 头。null = 没带 Range（回整包）；"ignore" = 畸形/
// 多段/其他单位（按 RFC 7233 忽略该头，回整包，客户端能自行退化）；
// "unsat" = 起点越界（回 416）；其余为闭区间 [start, end]，已夹紧到
// 文件实际大小。
function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | "ignore" | "unsat" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "ignore";
  let start: number;
  let end: number;
  if (m[1] === "") {
    // bytes=-N：取末尾 N 字节。
    const n = Number(m[2]);
    if (n === 0 || size === 0) return "unsat";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return "unsat";
  return { start, end };
}

export function registerDownloadRoutes(app: FastifyInstance): void {
  const dir = path.resolve(
    process.env.UPDATE_DIR ?? path.join(config.dataDir, "update"),
  );

  app.get("/download/:file", (req, reply) => {
    const file = (req.params as { file: string }).file;
    // 拒绝路径穿越：只允许纯文件名（部署产物名都是 ASCII）。
    if (!/^[\w.-]+$/.test(file)) {
      return reply.code(400).send({ error: "invalid_file" });
    }
    const full = path.join(dir, file);
    if (!fs.existsSync(full)) {
      return reply.code(404).send({ error: "not_found" });
    }
    const st = fs.statSync(full);
    if (!st.isFile()) {
      return reply.code(404).send({ error: "not_found" });
    }
    const size = st.size;
    const ext = path.extname(file).toLowerCase();
    const range = parseRange(req.headers.range, size);

    if (range === "unsat") {
      return reply
        .code(416)
        .header("content-range", `bytes */${size}`)
        .send();
    }
    if (range && range !== "ignore") {
      return reply
        .code(206)
        .header("content-type", MIME[ext] ?? "application/octet-stream")
        .header("content-range", `bytes ${range.start}-${range.end}/${size}`)
        .header("content-length", range.end - range.start + 1)
        .send(fs.createReadStream(full, { start: range.start, end: range.end }));
    }
    return reply
      .header("content-type", MIME[ext] ?? "application/octet-stream")
      .header("accept-ranges", "bytes")
      .header("content-length", size)
      .send(fs.createReadStream(full));
  });
}
