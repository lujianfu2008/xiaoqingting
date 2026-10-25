import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { publicProjectDir } from "../store.js";
import { FILE_TIMEOUT_MS, textResult, type RunAction } from "./clientTools/shared.js";

// 公有域项目（共有知识库）的服务端执行器：与 clientTools 同名的文件工具，
// 但直接在服务器的公有工作空间（data/public-projects/<projectId>/）执行，
// 而不是转发到用户电脑。路径以工作空间根为界做围栏；任何输出都只用逻辑
// 路径，绝不暴露服务器绝对路径。不提供 run_command / browser / choose_workdir。

export const PUBLIC_WORKSPACE_CONTENT_MAX = 2_000_000;

// 供 canUseTool 自动放行（真正的审批门在 write_file 工具体内）。
export function publicToolQualifiedNames(): string[] {
  return ["read_file", "write_file", "list_dir", "get_workdir"].map(
    (n) => `mcp__public__${n}`,
  );
}

/** 把工作空间内的逻辑路径解析为安全绝对路径；越界返回 null。 */
export function resolvePublicPath(projectId: string, logical: string): string | null {
  const base = path.resolve(publicProjectDir(projectId));
  const target = path.resolve(base, logical.replace(/^\/+/, "").trim());
  const rel = path.relative(base, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return target;
}

export interface PublicWorkspaceOpts {
  projectId: string;
  projectName: string;
  /** 会话主人是公有域管理员：写直接落盘；否则写转为更新申请。 */
  ownerIsAdmin: boolean;
  /** 普通成员提交写入，返回申请编号。 */
  submitWrite: (logicalPath: string, content: string) => Promise<{ requestId: string }>;
}

function toLogical(projectId: string, p: string): string {
  const trimmed = p.replace(/^\/+/, "").trim();
  return `/public-projects/${projectId}/${trimmed}`;
}

export function createPublicRun(opts: PublicWorkspaceOpts): RunAction {
  const { projectId, projectName, ownerIsAdmin, submitWrite } = opts;

  return async (action, params) => {
    if (action === "get_workdir") {
      return {
        ok: true,
        output:
          `公有域知识库工作空间：/public-projects/${projectId}（项目：${projectName}）\n` +
          "全部成员可读取/列出其中的文件；" +
          (ownerIsAdmin
            ? "你是公有域管理员：写入直接生效。"
            : "写入会自动转为更新申请，管理员批准后才会真正写入。"),
      };
    }

    if (action === "read_file" || action === "list_dir") {
      const p = String(params.path ?? "");
      const target = resolvePublicPath(projectId, p);
      if (!target) return { ok: false, error: "路径超出公有域工作空间。" };
      try {
        if (action === "read_file") {
          return { ok: true, output: fs.readFileSync(target, "utf8") };
        }
        const entries = fs.readdirSync(target, { withFileTypes: true });
        if (entries.length === 0) return { ok: true, output: "(空目录)" };
        return {
          ok: true,
          output: entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n"),
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    if (action === "write_file") {
      const p = String(params.path ?? "");
      const content = String(params.content ?? "");
      const target = resolvePublicPath(projectId, p);
      if (!target) return { ok: false, error: "路径超出公有域工作空间，写入被拒绝。" };
      if (ownerIsAdmin) {
        try {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, content, "utf8");
          return { ok: true, output: `已写入 ${toLogical(projectId, p)}` };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      const { requestId } = await submitWrite(p, content);
      return {
        ok: true,
        output:
          `已提交更新申请（编号 ${requestId}）：待管理员批准后写入 ${toLogical(projectId, p)}，` +
          "批准前知识库内容不会变化。",
      };
    }

    return { ok: false, error: "公有域会话不支持该操作（如命令执行、浏览器等）。" };
  };
}

export function createPublicServer(run: RunAction) {
  const readFile = tool(
    "read_file",
    "读取公有域知识库中的文本文件内容。相对路径基于公有域工作空间根目录；可先用 get_workdir 了解",
    { path: z.string().describe("文件路径（相对路径基于公有域工作空间根目录）") },
    async (args) => textResult(await run("read_file", args, FILE_TIMEOUT_MS)),
  );

  const writeFile = tool(
    "write_file",
    "写入（创建或覆盖）公有域知识库中的文本文件。管理员写入直接生效；普通成员的写入会自动转为更新申请，管理员批准后才会真正写入",
    {
      path: z.string().describe("文件路径（相对路径基于公有域工作空间根目录）"),
      content: z
        .string()
        .max(PUBLIC_WORKSPACE_CONTENT_MAX)
        .describe("要写入的完整内容"),
    },
    async (args) => textResult(await run("write_file", args, FILE_TIMEOUT_MS)),
  );

  const listDir = tool(
    "list_dir",
    "列出公有域知识库中某个目录的内容。相对路径基于公有域工作空间根目录",
    { path: z.string().describe("目录路径（相对路径基于公有域工作空间根目录）") },
    async (args) => textResult(await run("list_dir", args, FILE_TIMEOUT_MS)),
  );

  const getWorkdir = tool(
    "get_workdir",
    "获取公有域知识库工作空间的信息（可读范围、写入规则），所有文件操作前应先了解",
    {},
    async () => textResult(await run("get_workdir", {}, FILE_TIMEOUT_MS)),
  );

  return createSdkMcpServer({
    name: "public",
    version: "1.0.0",
    tools: [readFile, writeFile, listDir, getWorkdir],
  });
}
