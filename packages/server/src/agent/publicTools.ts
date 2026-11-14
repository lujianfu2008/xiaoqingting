import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { publicProjectDir } from "../store.js";
import { FILE_TIMEOUT_MS, textResult, type RunAction } from "./clientTools/shared.js";

// 公有域项目（共有知识库）的服务端执行器：与 clientTools 同名的文件工具，
// 但直接在服务器的公有工作空间（data/public-projects/<projectId>/）执行，
// 而不是转发到用户电脑。路径以工作空间根为界做围栏；任何输出都只用逻辑
// 路径，绝不暴露服务器绝对路径。不提供 browser；工作目录等空间设置不是
// 智能体工具（用户在界面里改）。
// run_command 仅对被授权的工号可用（publicExecAuth.ts），在服务端执行。

export const PUBLIC_WORKSPACE_CONTENT_MAX = 2_000_000;

// run_command：对齐 clientTools 的命令超时；输出截断防止把
// 海量输出灌进模型上下文。
const PUBLIC_CMD_TIMEOUT_MS = 120_000;
const PUBLIC_CMD_OUTPUT_MAX = 64 * 1024;

// 供 canUseTool 自动放行（真正的审批门在 write_file 工具体内；
// run_command 的门在工具体内的授权检查）。
export function publicToolQualifiedNames(): string[] {
  return ["read_file", "write_file", "list_dir", "get_workdir", "run_command"].map(
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
  /** 会话主人已授权服务端命令执行（run_command）。 */
  runCommandAuthorized: boolean;
  /** 普通成员提交写入，返回申请编号。 */
  submitWrite: (logicalPath: string, content: string) => Promise<{ requestId: string }>;
}

function toLogical(projectId: string, p: string): string {
  const trimmed = p.replace(/^\/+/, "").trim();
  return `/public-projects/${projectId}/${trimmed}`;
}

export function createPublicRun(opts: PublicWorkspaceOpts): RunAction {
  const { projectId, projectName, ownerIsAdmin, runCommandAuthorized, submitWrite } = opts;

  return async (action, params) => {
    if (action === "get_workdir") {
      return {
        ok: true,
        output:
          `公有域知识库工作空间：/public-projects/${projectId}（项目：${projectName}）\n` +
          "全部成员可读取/列出其中的文件；" +
          (ownerIsAdmin
            ? "你是公有域管理员：写入直接生效。"
            : "写入会自动转为更新申请，管理员批准后才会真正写入。") +
          (runCommandAuthorized
            ? "你已获授权在该工作空间内执行命令（run_command）。"
            : ""),
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

    if (action === "run_command") {
      const cmd = String(params.command ?? "").trim();
      if (!cmd) return { ok: false, error: "缺少 command 参数。" };
      if (!runCommandAuthorized) {
        return { ok: false, error: "公有域会话未授权命令执行，请联系管理员开通。" };
      }
      // cwd 锁定公有工作空间根；env 白名单式最小化——绝不透传
      // process.env（其中含服务器机密），只给命令运行所需的基础变量。
      const dir = publicProjectDir(projectId);
      const output = await new Promise<string>((resolve) => {
        execFile(
          "bash",
          ["-c", cmd],
          {
            cwd: dir,
            timeout: PUBLIC_CMD_TIMEOUT_MS,
            maxBuffer: 10 * 1024 * 1024,
            env: {
              PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
              LANG: process.env.LANG ?? "C.UTF-8",
              TZ: process.env.TZ,
              HOME: dir,
              SHELL: "/bin/bash",
              TERM: process.env.TERM,
            },
          },
          (err, stdout, stderr) => {
            let out = String(stdout);
            if (stderr) out += (out ? "\n" : "") + String(stderr);
            if (err) {
              const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
              const killed = (err as { killed?: boolean }).killed;
              const reason =
                killed ? `（超时 ${PUBLIC_CMD_TIMEOUT_MS / 1000}s 被终止）`
                : typeof code === "number" ? `（退出码 ${code}）`
                : `（${err.message}）`;
              out += (out ? "\n" : "") + `[命令失败${reason}]`;
            }
            resolve(out);
          },
        );
      });
      const trimmed =
        output.length > PUBLIC_CMD_OUTPUT_MAX
          ? output.slice(0, PUBLIC_CMD_OUTPUT_MAX) + "\n…（输出过长已截断）"
          : output;
      return { ok: true, output: trimmed || "(无输出)" };
    }

    return { ok: false, error: "公有域会话不支持该操作（如浏览器等）。" };
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

  const runCommand = tool(
    "run_command",
    "在服务端的公有域知识库工作空间内执行 shell 命令（bash）。当前目录即工作空间根目录，可用于处理工作空间内的文件（如 curl 抓取网页、批量转换格式）。仅被授权的账号可用",
    { command: z.string().describe("要执行的 bash 命令") },
    async (args) => textResult(await run("run_command", args, PUBLIC_CMD_TIMEOUT_MS)),
  );

  return createSdkMcpServer({
    name: "public",
    version: "1.0.0",
    tools: [readFile, writeFile, listDir, getWorkdir, runCommand],
  });
}
