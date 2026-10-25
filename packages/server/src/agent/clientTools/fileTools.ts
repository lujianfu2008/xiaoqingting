import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { attachmentResult, CMD_TIMEOUT_MS, FILE_TIMEOUT_MS, textResult, type RunAction } from "./shared.js";

// Client tools that read/write files, run commands, or manage the work dir.

export function fileTools(run: RunAction, attachmentMode: "image" | "ocr") {
  const runCommand = tool(
    "run_command",
    "在用户的电脑上执行一条命令行命令（如 dir、ipconfig、python 脚本等），返回命令输出",
    { command: z.string().describe("要执行的命令") },
    async (args) => textResult(await run("run_command", args, CMD_TIMEOUT_MS)),
  );

  const readFile = tool(
    "read_file",
    "读取用户电脑上的文本文件内容。相对路径基于工作目录；工作目录之外的绝对路径是否可读取决于用户的访问范围设置，可先用 get_workdir 查询",
    { path: z.string().describe("文件路径（相对路径基于用户设定的工作目录）") },
    async (args) => textResult(await run("read_file", args, FILE_TIMEOUT_MS)),
  );

  const writeFile = tool(
    "write_file",
    "在用户电脑上写入（创建或覆盖）文本文件。只能写入工作目录之内：工作目录之外一律只读，写入会被拒绝",
    {
      path: z.string().describe("文件路径（相对路径基于用户设定的工作目录）"),
      content: z.string().describe("要写入的完整内容"),
    },
    async (args) => textResult(await run("write_file", args, FILE_TIMEOUT_MS)),
  );

  const listDir = tool(
    "list_dir",
    "列出用户电脑上某个目录的内容。相对路径基于工作目录；工作目录之外的绝对路径是否可读取决于用户的访问范围设置，可先用 get_workdir 查询",
    { path: z.string().describe("目录路径（相对路径基于用户设定的工作目录）") },
    async (args) => textResult(await run("list_dir", args, FILE_TIMEOUT_MS)),
  );

  const getWorkdir = tool(
    "get_workdir",
    "获取用户电脑上当前的工作目录和访问范围（哪些位置可读、写入/删除的限制），所有文件操作前应先了解",
    {},
    async () => textResult(await run("get_workdir", {}, FILE_TIMEOUT_MS)),
  );

  const chooseWorkdir = tool(
    "choose_workdir",
    "请用户在电脑上重新选择（或更改）智能体的工作目录，会弹出目录选择窗口",
    {},
    async () => textResult(await run("choose_workdir", {}, FILE_TIMEOUT_MS)),
  );

  // Image/text viewer for the user's machine. Scoped hard to steer the model
  // away from read_file-on-binary flailing: any image (message attachments
  // AND workdir files) must go through here. The read mode is fixed
  // server-side by the engine model's vision capability: image mode returns
  // the picture itself, ocr mode returns recognized text.
  const readAttachment = tool(
    "read_attachment",
    "查看图片文件的内容（用户随消息附上的截图，以及工作目录里的任何图片都适用）：以图像形式返回，或在无法直接看图时返回图片文字识别结果。也能读取文本类文件。read_file 只支持文本，读图片只会得到乱码——所有图片一律用本工具",
    { path: z.string().describe("文件路径（相对路径基于工作目录；[附件] 行则照抄 → 之后的完整路径）") },
    async (args) => attachmentResult(await run("read_attachment", { path: args.path, mode: attachmentMode }, FILE_TIMEOUT_MS)),
  );

  return [runCommand, readFile, writeFile, listDir, getWorkdir, chooseWorkdir, readAttachment];
}
