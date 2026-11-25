// 回归测试：内置阅读器文本嗅探 / 解码（packages/desktop/src/main/textSniff.ts）。
// 运行：npx tsx scripts/test-textsniff.ts
// 背景 bug：utf-8 strict 用前 8192 字节样本，样本常切在汉字中间
// （末字节是 0xE5 或续字节），合法中文 UTF-8 文档被误判 → binary。
// 修复：整文件 utf-8 strict 优先，样本只用于 NUL 占比检测（含字符边界回退）。

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { sniffText, readTextFile } from "../packages/desktop/src/main/textSniff";

const GB = (s: string) => Buffer.from(s, "utf8");

let pass = 0;
let fail = 0;
async function t(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}:`);
    console.error(`    ${(e as Error).message}`);
  }
}

async function tmpFile(contents: Buffer): Promise<string> {
  const p = path.join(
    await fsp.mkdtemp(path.join(os.tmpdir(), "textsniff-file-")),
    "t.bin",
  );
  await fsp.writeFile(p, contents);
  return p;
}

async function main(): Promise<void> {
  console.log("「关键修复」中文 UTF-8（样本切在汉字中间）→ utf8");
  await t("长度恰跨 8192 字节、末尾是完整汉字", () => {
    const chinese = "优化梳理流程中遇到的中文文本测试".repeat(500); // ~20KB
    const buf = GB(chinese);
    const r = sniffText(buf);
    assert.equal(r.kind, "text");
    assert.equal(r.encoding, "utf8");
    assert.equal(r.text, chinese);
  });

  await t("样本最后一字节是汉字首字节 0xE5 → 整文件校验通过", () => {
    // 正文(8191 ASCII) + "中"(e4 b8 ad)。旧逻辑 8KB 样本止于 8191，
    // 即 3 字节字符的尾字节被切断，fatal 必抛 → 误判 binary。
    // 新逻辑整文件 utf-8 strict 通过。
    const buf = Buffer.concat([Buffer.alloc(8191, 0x61), GB("中")]);
    const r = sniffText(buf);
    assert.equal(r.kind, "text");
    assert.equal(r.encoding, "utf8");
    assert.equal(r.text.split("中").length, 2);
  });

  await t("纯 ASCII 长文本 → utf8", () => {
    const r = sniffText(GB("plain ASCII ".repeat(1000)));
    assert.equal(r.kind, "text");
    assert.equal(r.encoding, "utf8");
  });

  console.log("GBK 文件（确实非 UTF-8）→ gbk（门限未放宽）");
  await t("GBK 中文文档 → gbk、无乱码", () => {
    // python3 预编码的 GBK 字节：d5e2cac7...（这条 SACI / 阅读器测试用）
    const gbkBytes = Buffer.from(
      "d5e2cac7d2bbb6cebcf2cce5d6d0cec447424bcec4b5b5d3c3d3dad4c4b6c1c6f7b2e2cad4a1a3",
      "hex",
    );
    const r = sniffText(gbkBytes);
    assert.equal(r.kind, "text");
    assert.equal(r.encoding, "gbk");
    assert.ok(r.text.includes("中文"), `GBK 解码应含「中文」：${r.text}`);
    assert.equal(r.text.includes("�"), false, "GBK 解码不应有乱码");
  });
  await t("GBK 中文文档经 readTextFile → gbk text", async () => {
    const gbkBytes = Buffer.from(
      "d5e2cac7d2bbb6cebcf2cce5d6d0cec447424bcec4b5b5d3c3d3dad4c4b6c1c6f7b2e2cad4a1a3",
      "hex",
    );
    const p = await tmpFile(gbkBytes);
    const r = await readTextFile(p, 10 * 1024);
    assert.equal(r.kind, "text");
    assert.equal(r.encoding, "gbk");
  });

  console.log("BOM 确定性编码");
  await t("UTF-8 BOM → utf8（去掉 BOM 字符）", () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), GB("你好世界")]);
    const r = sniffText(buf);
    assert.equal(r.kind, "text");
    assert.equal(r.encoding, "utf8");
    assert.equal(r.text, "你好世界");
  });
  await t("UTF-16LE BOM → utf16le", () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("你", "utf16le")]);
    const r = sniffText(buf);
    assert.equal(r.kind, "text");
    assert.equal(r.encoding, "utf16le");
    assert.ok(r.text.includes("你"), `text=${JSON.stringify(r.text)}`);
  });
  await t("UTF-16BE BOM → 交换字节 → utf16le", () => {
    const be = Buffer.alloc(2);
    be.writeUInt16BE("你".charCodeAt(0), 0); // "你"=U+4F60 写成 BE
    const buf = Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
    const r = sniffText(buf);
    assert.equal(r.kind, "text");
    assert.equal(r.encoding, "utf16le");
    assert.ok(r.text.includes("你"), `text=${JSON.stringify(r.text)}`);
  });

  console.log("二进制判定（NUL 门限 1% 未放宽）");
  await t("NUL 占比 >1% → binary", () => {
    // 10 个 NUL + 10 个 ascii = 50% → binary
    const buf = Buffer.concat([Buffer.alloc(10, 0), Buffer.alloc(10, 0x61)]);
    assert.equal(sniffText(buf).kind, "binary");
  });
  await t("NUL 稀疏（<1%）→ 仍按 utf8", () => {
    // 1 个 NUL + 220 ascii ≈ 0.45% → text
    const buf = Buffer.concat([Buffer.from([0]), GB("a".repeat(220))]);
    const r = sniffText(buf);
    assert.equal(r.kind, "text");
  });
  await t(".exe 类字节（非 utf8、GBK 乱码多）→ binary", () => {
    const buf = Buffer.concat([
      GB("MZ"),
      Buffer.from([0x90, 0x00, 0x03]),
      Buffer.from(Array.from({ length: 200 }, (_, i) => (i % 7) * 31 + 0x80)),
    ]);
    assert.equal(sniffText(buf).kind, "binary");
  });
  await t(".pak 类随机高位字节 → binary", () => {
    const buf = Buffer.from(Array.from({ length: 300 }, (_, i) => ((i * 13) % 256)));
    assert.equal(sniffText(buf).kind, "binary");
  });

  console.log("readTextFile（文件系统外壳）");
  await t("空文件 → empty", async () => {
    const p = await tmpFile(Buffer.alloc(0));
    assert.equal((await readTextFile(p, 1000)).kind, "empty");
  });
  await t("目录 → error", async () => {
    const d = await fsp.mkdtemp(path.join(os.tmpdir(), "textsniff-dir-"));
    const r = await readTextFile(d, 1000);
    assert.equal(r.kind, "error");
    assert.ok((r as { error: string }).error.length > 0);
  });
  await t("超 max_bytes → too_large", async () => {
    const p = await tmpFile(Buffer.alloc(2000, 0x61));
    assert.equal((await readTextFile(p, 1000)).kind, "too_large");
  });
  await t("截断按 4 字节预算上限", async () => {
    const p = await tmpFile(GB("汉字重复中文内容文本".repeat(500))); // 3000 字
    const r = await readTextFile(p, 2000);
    if (r.kind === "text") {
      assert.equal(r.truncated, true);
      assert.ok(r.text.length <= Math.floor(2000 / 4), `len=${r.text.length}`);
    }
  });

  console.log("模拟真实长中文 MD（>8192B）→ utf8");
  await t("长中文 MD（200 节 × 标题+正文）", () => {
    const paras = Array.from(
      { length: 200 },
      (_, i) => `## 第 ${i} 节优化梳理\n\n这是第 ${i} 节的内容：请求发起后服务端\n立即返回，后续结果以 **流式** 推送。\n`,
    ).join("\n");
    const buf = GB(paras);
    assert.ok(buf.length > 8192, `fixture 应 >8192B，实际 ${buf.length}`);
    const r = sniffText(buf);
    assert.equal(r.kind, "text", `长中文 MD 被误判：${r.kind}`);
    assert.equal(r.encoding, "utf8");
    console.log(`     （fixture ${buf.length}B → utf8）`);
  });

  console.log(`\n${fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILED`}: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

void main();
