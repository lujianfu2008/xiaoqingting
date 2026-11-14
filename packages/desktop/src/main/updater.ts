import { autoUpdater } from "electron-updater";
import { BrowserWindow, dialog } from "electron";
import { uiStrings } from "./i18n";
import { currentLanguage } from "./menu";

// 桌面自动更新：更新源是用户所连的服务器（<serverUrl>/download/，
// 服务端 UPDATE_DIR 白名单目录）。登录成功后 renderer 把服务器
// 地址传进来再检查更新；失败静默（无网/老服务端没有该目录/版本
// 相同都不算事），下载完成弹提示、用户确认后重启安装。
// NSIS oneClick 安装包天然支持 autoUpdater 的差量下载。

let configuredFor: string | null = null;

// 装完不自动拉起：quitAndInstall 默认带 --force-run，安装器收尾的
// StdUtils.ExecShellAsUser 在部分中文 Windows 上弹「该文件没有与之
// 关联的应用」错误框（同 electron-builder.yml 里 runAfterFinish: false
// 的注释——那个开关只管手动跑安装器，自动更新的这条路径要在这里关）。
// 用户更新后从桌面/开始菜单快捷方式启动。
if (autoUpdater.autoRunAppAfterInstall !== false) autoUpdater.autoRunAppAfterInstall = false;

/** 推给所有窗口的渲染层（节流后）：下载进度 / 状态。 */
export type UpdateProgressState = {
  /** idle = 没有下载在进行（进度条隐藏）。 */
  phase: "idle" | "downloading" | "downloaded";
  percent: number; // 0–100，保留 1 位小数
  transferred?: number; // 已下载字节
  total?: number; // 总字节
  bytesPerSecond?: number;
};

let lastPush = 0;

function pushProgress(state: UpdateProgressState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("blm:updater:progress", state);
  }
}

/** download-progress 触发很密（每 chunk 一次）：500ms 节流，
 * 完成/出错事件不经节流立即推。 */
function onDownloadProgress(info: {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}): void {
  const now = Date.now();
  if (now - lastPush < 500) return;
  lastPush = now;
  pushProgress({
    phase: "downloading",
    percent: Math.min(100, Math.max(0, info.percent)),
    transferred: info.transferred,
    total: info.total,
    bytesPerSecond: info.bytesPerSecond,
  });
}

function resetProgress(): void {
  lastPush = 0;
  pushProgress({ phase: "downloading", percent: 0 });
}

/** renderer 登录后调用：绑定更新源并检查一次（同一服务器只配一次）。 */
export function bindUpdater(serverUrl: string): void {
  const feed = `${serverUrl.replace(/\/+$/, "")}/download/`;
  if (configuredFor === feed) return;
  configuredFor = feed;
  // generic provider：读 latest.yml 定版本，差量按 blockmap 走。
  autoUpdater.setFeedURL({ provider: "generic", url: feed, channel: "latest" });
  wireEvents();
  // 启动即查；老服务端 404/网络不通都静默。
  void autoUpdater.checkForUpdates().catch(() => undefined);
}

/** 手动重查（设置面板「检查更新」入口）：就地返回检查结果供
 * 面板显示；发现新版本时后台继续下载，下载完成仍走弹窗。 */
export function checkNow(): Promise<"up_to_date" | "available" | "error"> {
  return new Promise((resolve) => {
    if (!configuredFor) return resolve("error");
    // 只认本次检查自己的事件：临时挂一次性监听，落定即拆，
    // 避免混进登录时后台首次检查的迟到事件。
    const onAvail = (): void => settle("available");
    const onNone = (): void => settle("up_to_date");
    const onErr = (): void => settle("error");
    let settle: (v: "up_to_date" | "available" | "error") => void = resolve;
    // 兜底超时：无代理黑洞式的网络下 error 事件可能迟迟不来。
    const timer = setTimeout(() => settle("error"), 20_000);
    settle = (v) => {
      clearTimeout(timer);
      autoUpdater.off("update-available", onAvail);
      autoUpdater.off("update-not-available", onNone);
      autoUpdater.off("error", onErr);
      resolve(v);
    };
    autoUpdater.on("update-available", onAvail);
    autoUpdater.on("update-not-available", onNone);
    autoUpdater.on("error", onErr);
    void autoUpdater.checkForUpdates().catch(() => settle("error"));
  });
}

function wireEvents(): void {
  let once = false;
  autoUpdater.on("download-progress", onDownloadProgress);
  autoUpdater.on("update-downloaded", (info) => {
    pushProgress({
      phase: "downloaded",
      percent: 100,
      total: info.files?.[0]?.size,
    });
    if (once) return; // 同一版本只提醒一次
    once = true;
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    const s = uiStrings(currentLanguage(), { version: info.version ?? "" });
    void dialog
      .showMessageBox(win, {
        type: "info",
        title: s.updateTitle,
        message: s.updateFound,
        buttons: [s.updateInstall, s.updateLater],
        defaultId: 0,
        cancelId: 1,
      })
      .then((r) => {
        if (r.response === 0) autoUpdater.quitAndInstall();
        once = false;
      });
  });
  // 新检查开始时进度归零（重复更新同一版本也可能重下）。
  autoUpdater.on("update-available", resetProgress);
  // 检查失败/无新版：把进度条收掉（error 可能来自下载中断）。
  autoUpdater.on("update-not-available", () =>
    pushProgress({ phase: "idle", percent: 0 }),
  );
  // 出错静默：更新是后台 best-effort，不打扰使用；进度条一并收掉。
  autoUpdater.on("error", () => pushProgress({ phase: "idle", percent: 0 }));
}
