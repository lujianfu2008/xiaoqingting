#!/usr/bin/env node
// 打包产物自动部署：release/ → 服务端更新目录。
// UPDATE_DIR 可覆盖目标目录（与服务端 config.ts 同名变量同义），
// 默认 ../server/data/update。顺序：带版本号的产物（exe/blockmap）
// 先拷，latest.yml 最后拷——避免中间态元数据指向旧包。收尾清理
// 两处目录：更新目录保留上一版+当前版（上一版 blockmap 是客户端
// 差量下载的比对基准，不能删），release/ 删解包目录与调试文件。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const releaseDir = path.join(here, "..", "release");
const updateDir = process.env.UPDATE_DIR
  ? path.resolve(process.env.UPDATE_DIR)
  : path.join(here, "..", "..", "server", "data", "update");

const versionOf = (name) => /(\d+\.\d+\.\d+)/.exec(name)?.[1] ?? null;
const cmpNewer = (a, b) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
};

const yml = fs.readFileSync(path.join(releaseDir, "latest.yml"), "utf8");
const current = versionOf(/^version:\s*(.+)$/m.exec(yml)?.[1] ?? "");
if (!current) {
  console.error("[deploy] latest.yml 缺 version，放弃部署");
  process.exit(1);
}

fs.mkdirSync(updateDir, { recursive: true });

// 1) 部署：当前版产物先拷，latest.yml 最后拷。
const artifacts = fs
  .readdirSync(releaseDir)
  .filter((f) => f !== "latest.yml" && versionOf(f) === current);
if (artifacts.length === 0) {
  console.error(`[deploy] release/ 里没有 ${current} 的产物，放弃部署`);
  process.exit(1);
}
for (const f of artifacts) {
  fs.copyFileSync(path.join(releaseDir, f), path.join(updateDir, f));
}
fs.copyFileSync(
  path.join(releaseDir, "latest.yml"),
  path.join(updateDir, "latest.yml"),
);
console.log(
  `[deploy] ${current}: ${[...artifacts, "latest.yml"].join("、")} -> ${updateDir}`,
);

// 2) 目录收尾：版本产物只留当前版+紧邻上一版（差量基准），更旧删除。
const prevOf = (dir) =>
  [...new Set(fs.readdirSync(dir).map((f) => versionOf(f)).filter(Boolean))]
    .filter((v) => cmpNewer(current, v))
    .sort((a, b) => (cmpNewer(a, b) ? -1 : 1))[0]; // 最新的旧版本
const prune = (dir) => {
  const prev = prevOf(dir);
  const keep = new Set([current, ...(prev ? [prev] : [])]);
  for (const f of fs.readdirSync(dir)) {
    const v = versionOf(f);
    if (!v) continue; // latest.yml 等不带动
    if (!keep.has(v)) {
      fs.rmSync(path.join(dir, f), { force: true, recursive: true });
      console.log(`[deploy] 清理旧产物 ${path.relative(here, dir)}/${f}`);
    }
  }
};

// 3) release/：解包目录与调试文件一律删，版本产物同规则保留。
for (const f of fs.readdirSync(releaseDir)) {
  const p = path.join(releaseDir, f);
  if (fs.statSync(p).isDirectory() || f === "builder-debug.yml") {
    fs.rmSync(p, { force: true, recursive: true });
  }
}
prune(updateDir);
prune(releaseDir);
console.log("[deploy] 完成（release 与更新目录只留上一版+当前版）");
