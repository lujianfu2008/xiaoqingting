// 内置文件阅读器的文本嗅探与解码（BOM → utf8 → GBK → binary）。
// 独立成纯模块：不依赖 electron（只消费 node:fs/promises 与 Buffer），
// 供测试脚本直接导入跑 sniff（主进程耦合留在 viewer.ts，这里不做 IPC）。
//
// 改动记录（中文 UTF-8 误判二进制）：
//   utf-8 strict 校验从「前 8192 字节样本」改为**整文件**——样本常切在
//   汉字中间（UTF-8 三字节字符首字节 0xE4/0xE5 落在样本末尾即被截断），
//   合法 UTF-8 中文文档因此被误判成 GBK，乱码占比超 1% 进一步被打成
//   binary。整文件解码不存在切字符问题：通过即按 utf-8 返回。样本仍
//   只在 NUL 占比检测里用，取字符边界内（截尾回退 ≤3 字节）。
//
// GBK 兜底全平台启用：与 executor fileOps 的 win32-only 先例不同——
// 那里是控制台管道编码问题，这里是文件内容本身（同事发来的 GBK 文档
// 与平台无关）；Electron 全量 ICU 下 TextDecoder("gbk") 任何平台可用。

import fsp from "node:fs/promises";
import fs from "node:fs";
import type { ViewerReadResult } from "@blm/protocol";

export type TextSniffResult =
  | { kind: "text"; encoding: "utf8" | "utf16le" | "gbk"; text: string }
  | { kind: "binary" };

/** 把样本长度回退到 UTF-8 字符边界：0x80–0xBF 是连续字节，若样本末尾停
 * 在其中之一说明被切在多字节字符中间；最多回退 3 字节（UTF-8 最长 4 字节
 * 的尾部连续字节数）。只影响样本取值，不动文件内容。 */
function trimToBoundary(buf: Buffer, end: number): number {
  let retreated = 0;
  while (end > 0 && retreated < 3 && (buf[end - 1] & 0xc0) === 0x80) {
    end--;
    retreated++;
  }
  return end;
}

/** 纯嗅探：输入原始字节 → 文本（含编码）或 binary。不做截断/元信息。 */
export function sniffText(buf: Buffer): TextSniffResult {
  // BOM 探测（确定性编码）。
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { kind: "text", encoding: "utf8", text: buf.toString("utf8").slice(1) };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { kind: "text", encoding: "utf16le", text: buf.toString("utf16le").slice(1) };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16BE 手工交换成 LE 再解。
    const sw = Buffer.from(buf.subarray(2));
    sw.swap16();
    return { kind: "text", encoding: "utf16le", text: sw.toString("utf16le") };
  }

  // 无 BOM：NUL 占比超限判二进制（NUL 是合法 utf8——纯零字节文件不能当
  // 文本展示）。样本截尾回退到字符边界，边界字节不干扰占比判定。
  const sampleEnd = trimToBoundary(buf, Math.min(buf.length, 8192));
  const sample = buf.subarray(0, sampleEnd);
  let nuls = 0;
  for (const b of sample) if (b === 0) nuls++;
  if (nuls / Math.max(sample.length, 1) > 0.01) return { kind: "binary" };

  // **整文件** utf-8 strict 校验优先（关键）：通过即按 utf-8 返回。
  // 样本检测被样本尾切在汉字中间一事报废——整文件解码没有切边界问题。
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return { kind: "text", encoding: "utf8", text };
  } catch {
    // 非 utf-8 → GBK 兜底（门限勿放宽，正确路径是上面的整文件 utf-8）。
  }

  // GBK 全解：U+FFFD 乱码占比 ≤1% 当文本；占比仍高 → 二进制。
  try {
    const gbk = new TextDecoder("gbk").decode(buf);
    const bad = (gbk.match(/�/g) ?? []).length;
    if (bad / Math.max(gbk.length, 1) <= 0.01) {
      return { kind: "text", encoding: "gbk", text: gbk };
    }
  } catch {
    // 无 full-ICU 时 TextDecoder("gbk") 抛错 → binary
  }
  return { kind: "binary" };
}

function textResult(
  text: string,
  encoding: "utf8" | "utf16le" | "gbk",
  totalBytes: number,
  maxBytes: number,
): ViewerReadResult {
  // 按字符截断到字节预算内（上限余量防止单字符越界）。
  const maxChars = Math.floor(maxBytes / 4);
  const truncated = text.length > maxChars;
  if (truncated) text = text.slice(0, maxChars);
  return { kind: "text", text, encoding, truncated, total_bytes: totalBytes };
}

/** 读文件 + 嗅探 + 截断，返回 renderer 的 ViewerReadResult。 */
export async function readTextFile(
  p: string,
  maxBytes: number,
): Promise<ViewerReadResult> {
  let st: fs.Stats;
  try {
    st = await fsp.stat(p);
  } catch (e) {
    return { kind: "error", error: `无法读取：${(e as Error).message}` };
  }
  if (st.isDirectory()) return { kind: "error", error: "这是一个目录" };
  if (st.size === 0) return { kind: "empty" };
  if (st.size > maxBytes) return { kind: "too_large", size: st.size, max_bytes: maxBytes };

  let buf: Buffer;
  try {
    buf = await fsp.readFile(p);
  } catch (e) {
    return { kind: "error", error: `无法读取：${(e as Error).message}` };
  }
  // 长度取读到的实际字节数（TOCTOU 窗口里文件可能变大）。
  const total = Math.min(buf.length, st.size);

  const sniff = sniffText(buf);
  if (sniff.kind === "binary") return { kind: "binary" };
  return textResult(sniff.text, sniff.encoding, total, maxBytes);
}
