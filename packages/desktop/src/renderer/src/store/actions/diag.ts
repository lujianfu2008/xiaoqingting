import type { DiagLayout, DiagResult } from "@blm/protocol";
import type { BlmState, GetState, SetState } from "../types";
import { sendJson } from "../socket";
import { LS } from "../persist";

// 显示诊断：服务端（管理员经 REST）发 diag_request，这里采集
// 布局摘要（纯几何数字 + 版本）回 diag_result。截图 scope 另向
// 主进程要整窗 PNG。diagAllowScreenshot=false 时一律不采
// 截图（只回摘要）——含聊天内容的画面由用户自己开关把关。

/** 测量一个 pane 的当前宽度（未显示为 null）。 */
function paneWidth(selector: string): number | null {
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? Math.round(r.width) : null;
}

async function collectScreenshot(): Promise<{
  media_type: string;
  data: string;
  posed: boolean;
} | null> {
  const shot = await window.blm.diagScreenshot().catch(() => null);
  // 旧客户端 preload（无返回对象）兜底：bare NativeImage。
  const img: Electron.NativeImage | null =
    shot && typeof shot === "object" && "image" in shot
      ? (shot as { image: Electron.NativeImage }).image
      : (shot as unknown as Electron.NativeImage | null);
  const posed = shot !== null && typeof shot === "object" && "posed" in shot
    ? (shot as { posed: boolean }).posed
    : true;
  if (!img) return null;
  // 渲染进程没有 Node Buffer：toPNG() 是 Uint8Array，
  // 直接 toString("base64") 会得到十进制逗号串。手工按
  // base64 字母表编码字节。
  const bytes = img.toPNG();
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return { media_type: "image/png", data: btoa(bin), posed };
}

async function collectLayout(get: GetState): Promise<DiagLayout> {
  const browserRect = document
    .querySelector(".browser-pane")
    ?.getBoundingClientRect();
  // 每个原料都独立兜底：新服务端 + 旧客户端的过渡组合里，
  // preload 可能没有某个新方法（diagAppVersion 是 0.5.92
  // 才加的——0.5.91 客户端在这里 TypeError 后整个采集静默
  // 失败，服务端只见「无回执」）。typeof 防御 + 逐项兜底，
  // 摘要尽量回得去。
  const bb =
    typeof window.blm.diagBrowserBounds === "function"
      ? await window.blm.diagBrowserBounds().catch(() => null)
      : null;
  const appVersion =
    typeof window.blm.diagAppVersion === "function"
      ? await window.blm.diagAppVersion().catch(() => window.blm.versions.app)
      : window.blm.versions.app;
  // 屏幕真值（主进程 DPI 感知）：高 DPI 下 wmic/注册表
  // 全是虚拟化值，只有这里拿得到真数字。旧 preload 没有
  // 这个方法——可选，缺就缺。
  const scr =
    typeof window.blm.diagScreenInfo === "function"
      ? await window.blm.diagScreenInfo().catch(() => null)
      : null;
  return {
    at: new Date().toISOString(),
    app_version: appVersion,
    viewport: {
      w: window.innerWidth,
      h: window.innerHeight,
      dpr: window.devicePixelRatio,
    },
    panes: {
      sidebar: paneWidth(".sidebar"),
      viewer: paneWidth(".viewer-pane"),
      browser: paneWidth(".browser-pane"),
      chat: paneWidth(".main"),
    },
    browser_view: {
      open: get().browser.open && get().browser.mode === "embedded",
      bounds: bb
        ? { x: bb.x, y: bb.y, w: bb.width, h: bb.height }
        : null,
    },
    browser_pane_rect: browserRect
      ? {
          x: Math.round(browserRect.left),
          y: Math.round(browserRect.top),
          w: Math.round(browserRect.width),
          h: Math.round(browserRect.height),
        }
      : null,
    ...(scr
      ? {
          screen: {
            bounds: scr.bounds,
            workArea: scr.workArea,
            scaleFactor: scr.scaleFactor,
            contentSize: scr.contentSize,
          },
        }
      : {}),
  };
}

export function createDiagActions(
  set: SetState,
  get: GetState,
): Pick<
  BlmState,
  "diagAllowScreenshot" | "setDiagAllowScreenshot" | "collectDiag"
> {
  return {
    diagAllowScreenshot: localStorage.getItem(LS.diagAllowScreenshot) !== "0",
    setDiagAllowScreenshot(on) {
      set({ diagAllowScreenshot: on });
      localStorage.setItem(LS.diagAllowScreenshot, on ? "1" : "0");
    },

    async collectDiag(requestId, scope) {
      try {
        const layout = await collectLayout(get);
        const result: DiagResult = { request_id: requestId, layout };
        // 截图：请求方要 + 用户允许才采。用户关掉开关 = 只回摘要。
        if (scope === "screenshot" && get().diagAllowScreenshot) {
          const shot = await collectScreenshot();
          if (shot) {
            result.screenshot = {
              media_type: shot.media_type,
              data: shot.data,
            };
            // view 当时是否真在画面里（遮罩会藏掉它）。
            result.layout.browser_view.view_posed = shot.posed;
          }
        }
        sendJson({ type: "diag_result", result });
      } catch (e) {
        // 采集整体失败时回一份最小摘要（宁可少采也不错过）：
        // 服务端把「无回执」当作排障信号，静默丢弃等于失联。
        try {
          sendJson({
            type: "diag_result",
            result: {
              request_id: requestId,
              layout: {
                at: new Date().toISOString(),
                app_version:
                  window.blm?.versions?.app ?? "0.1.0(采集失败)",
                viewport: {
                  w: window.innerWidth,
                  h: window.innerHeight,
                  dpr: window.devicePixelRatio,
                },
                panes: { sidebar: null, viewer: null, browser: null, chat: null },
                browser_view: { open: false, bounds: null },
                browser_pane_rect: null,
              },
            },
          });
        } catch {
          // 连 WS 都不在：真失联，无事可做。
          void e;
        }
      }
    },
  };
}
