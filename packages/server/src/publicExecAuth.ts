import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { isBootstrapAdmin } from "./users.js";

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// 公有域服务端执行授权：被授权的工号可以在公有域会话里使用
// run_command（在服务器的公有工作空间内执行命令）。名单存
// data/public-exec-users.json（用户名 → true；与 relay-users.json
// 同理由 bootstrap 管理员不在 users.json 里，独立成文件）。
// bootstrap 管理员天然授权。

function authFile(): string {
  return path.join(config.dataDir, "public-exec-users.json");
}

/** bootstrap 管理员天然授权；其余按名单判断。 */
export function isPublicExecAuthorized(username: string): boolean {
  if (isBootstrapAdmin(username)) return true;
  const all = readJson(authFile());
  return (
    all !== null && typeof all === "object" && !Array.isArray(all) &&
    (all as Record<string, unknown>)[username] === true
  );
}

export function setPublicExecAuthorized(username: string, on: boolean): void {
  const all = (readJson(authFile()) ?? {}) as Record<string, unknown>;
  if (on) all[username] = true;
  else delete all[username];
  fs.mkdirSync(path.dirname(authFile()), { recursive: true });
  fs.writeFileSync(authFile(), JSON.stringify(all, null, 2));
}
