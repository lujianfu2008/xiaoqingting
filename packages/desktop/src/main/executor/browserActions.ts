import type { BrowserWindow } from "electron";
import * as browser from "../browser";
import { MAX_PAGE_TEXT, type ExecOutcome } from "./limits";

// Built-in browser actions (open/navigate/snapshot/close), no work dir needed.

export const BROWSER_ACTIONS = new Set([
  "browser_open",
  "browser_navigate",
  "browser_snapshot",
  "browser_close",
]);

export async function runBrowserAction(
  win: BrowserWindow,
  action: string,
  params: Record<string, unknown>,
): Promise<ExecOutcome> {
  switch (action) {
    case "browser_open":
    case "browser_navigate": {
      const url = String(params.url ?? "");
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: "网址必须以 http:// 或 https:// 开头。" };
      const res = await browser.open(win, url);
      if (!res.ok) return { ok: false, error: res.error };
      const snap = await browser.snapshot();
      const text = (snap.text ?? "").slice(0, MAX_PAGE_TEXT);
      return { ok: true, output: `已打开 ${url}\n\n页面内容：\n${text || "(页面暂无文本)"}` };
    }
    case "browser_snapshot": {
      const snap = await browser.snapshot();
      if (!snap.ok) return { ok: false, error: snap.error };
      return { ok: true, output: (snap.text ?? "").slice(0, MAX_PAGE_TEXT) || "(页面暂无文本)" };
    }
    case "browser_close": {
      browser.close();
      return { ok: true, output: "浏览器已关闭。" };
    }
    default:
      return { ok: false, error: `未知操作：${action}` };
  }
}
