import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { BROWSER_TIMEOUT_MS, FILE_TIMEOUT_MS, textResult, type RunAction } from "./shared.js";

// Client tools driving the user's built-in browser pane.

export function browserTools(run: RunAction) {
  const browserOpen = tool(
    "browser_open",
    "在用户的电脑上用内置浏览器打开一个网页（默认显示在主程序左侧分栏，聊天框在右侧；用户可设为弹窗）",
    { url: z.string().describe("要打开的网址（含 http/https）") },
    async (args) => textResult(await run("browser_open", args, BROWSER_TIMEOUT_MS)),
  );

  const browserNavigate = tool(
    "browser_navigate",
    "让内置浏览器跳转到新的网址",
    { url: z.string().describe("要跳转的网址（含 http/https）") },
    async (args) => textResult(await run("browser_navigate", args, BROWSER_TIMEOUT_MS)),
  );

  const browserSnapshot = tool(
    "browser_snapshot",
    "获取内置浏览器当前页面的文字内容（用于阅读网页）",
    {},
    async () => textResult(await run("browser_snapshot", {}, BROWSER_TIMEOUT_MS)),
  );

  const browserClose = tool(
    "browser_close",
    "关闭内置浏览器（分栏或弹窗）",
    {},
    async () => textResult(await run("browser_close", {}, FILE_TIMEOUT_MS)),
  );

  return [browserOpen, browserNavigate, browserSnapshot, browserClose];
}
